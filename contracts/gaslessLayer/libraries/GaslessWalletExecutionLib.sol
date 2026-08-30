// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { GaslessWallet } from "../GaslessWallet.sol";
import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { IInstantLayer } from "../interfaces/IInstantLayer.sol";
import { ISymmioAccountLayer } from "../interfaces/ISymmioAccountLayer.sol";
import { GaslessBillingIdentity } from "./GaslessBillingIdentity.sol";
import { GaslessLayerDomain } from "./GaslessLayerDomain.sol";
import { GaslessWalletDeployerLib } from "./GaslessWalletDeployerLib.sol";

/// @title GaslessWalletExecutionLib
/// @notice Linked wallet-operation validation and execution for GaslessLayer.
/// @dev Public entrypoints accept raw contract addresses instead of interface-typed arguments so ABI
///      tooling sees normal address parameters. The library still executes in gateway/proxy context via
///      delegatecall, so EIP-712 domains, CREATE2 wallet deployment, and nonce storage stay unchanged.
library GaslessWalletExecutionLib {
	// ───────────────────────── Constants ──────────────────────────

	bytes32 public constant WALLET_ACCOUNT_TYPEHASH = keccak256("Account(address addr,bool isPartyB)");
	bytes32 public constant WALLET_REPLAY_HEADER_TYPEHASH = keccak256("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)");
	// Preserve the original delegation selector across the naming-only migration.
	bytes4 public constant WALLET_EXECUTION_SENTINEL_SELECTOR = bytes4(keccak256("GASLESSQ_WALLET_EXECUTION"));
	bytes32 internal constant WALLET_SIGNED_OPERATION_TYPEHASH = keccak256(
		abi.encodePacked(
			"SignedOperation(address signer,address target,bytes callData,Account signerAccount,ReplayAttackHeader replayAttackHeader)",
			"Account(address addr,bool isPartyB)",
			"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
		)
	);

	// ─────────────────────────── Types ────────────────────────────

	struct WalletExecutionResult {
		bytes result;
		address ownerWallet;
		address wallet;
		uint256 callCount;
	}

	// ───────────────────── External Entrypoints ───────────────────

	function getWalletOperationHash(IInstantLayer.SignedOperation calldata signedOp) external view returns (bytes32) {
		return _getWalletOperationHash(signedOp);
	}

	function isValidWalletOperationSignature(IInstantLayer.SignedOperation calldata signedOp, bytes calldata signature) external view returns (bool) {
		return SignatureChecker.isValidSignatureNow(signedOp.signer, _getWalletOperationHash(signedOp), signature);
	}

	function isWalletOperation(address accountLayer, IInstantLayer.SignedOperation calldata signedOp) external view returns (bool) {
		return _isWalletOperation(ISymmioAccountLayer(accountLayer), signedOp);
	}

	function operationalFeeSelectors(
		address accountLayer,
		IInstantLayer.SignedOperation calldata signedOp
	) external view returns (bytes4[] memory selectors) {
		if (!_isWalletOperation(ISymmioAccountLayer(accountLayer), signedOp)) {
			selectors = new bytes4[](1);
			selectors[0] = _selectorFromCalldata(signedOp.callData);
			return selectors;
		}

		GaslessWallet.Call[] memory calls = _decodeWalletExecuteCalls(signedOp.callData);
		selectors = new bytes4[](calls.length);
		for (uint256 i = 0; i < calls.length; i++) {
			selectors[i] = _selectorFromMemory(calls[i].data);
		}
	}

	function executeWalletOperation(
		mapping(address => uint256) storage walletOperationNonces,
		address accountLayer,
		address instantLayer,
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature
	) external returns (WalletExecutionResult memory execution) {
		ISymmioAccountLayer accountLayerContract = ISymmioAccountLayer(accountLayer);
		IInstantLayer instantLayerContract = IInstantLayer(instantLayer);
		(address ownerWallet, address canonicalAccount) = _walletOwnerForOperation(accountLayerContract, signedOp);
		address expectedWallet = GaslessWalletDeployerLib.getGaslessWalletAddress(ownerWallet);
		if (signedOp.target != expectedWallet) revert IGaslessLayer.InvalidWalletOperationTarget(expectedWallet, signedOp.target);

		_verifyAndConsumeWalletOperationReplay(walletOperationNonces, signedOp, signature);
		GaslessWallet.Call[] memory calls = _decodeWalletExecuteCalls(signedOp.callData);
		_assertWalletAuthority(instantLayerContract, signedOp, ownerWallet, canonicalAccount, calls);

		(GaslessWallet wallet, ) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(ownerWallet);
		bytes[] memory results = wallet.execute(calls);
		execution = WalletExecutionResult({
			result: abi.encode(results),
			ownerWallet: ownerWallet,
			wallet: address(wallet),
			callCount: calls.length
		});
	}

	// ─────────────────────────── EIP-712 ──────────────────────────

	function _getWalletOperationHash(IInstantLayer.SignedOperation calldata signedOp) internal view returns (bytes32) {
		return
			GaslessLayerDomain.hashTypedData(
				keccak256(
					abi.encode(
						WALLET_SIGNED_OPERATION_TYPEHASH,
						signedOp.signer,
						signedOp.target,
						keccak256(signedOp.callData),
						_hashWalletAccount(signedOp.signerAccount),
						_hashWalletReplay(signedOp.replayAttackHeader)
					)
				)
			);
	}

	function _hashWalletAccount(IInstantLayer.Account calldata account) internal pure returns (bytes32) {
		return keccak256(abi.encode(WALLET_ACCOUNT_TYPEHASH, account.addr, account.isPartyB));
	}

	function _hashWalletReplay(IInstantLayer.ReplayAttackHeader calldata replayAttackHeader) internal pure returns (bytes32) {
		return keccak256(abi.encode(WALLET_REPLAY_HEADER_TYPEHASH, replayAttackHeader.nonce, replayAttackHeader.deadline, replayAttackHeader.salt));
	}

	// ─────────────────────────── Replay ───────────────────────────

	function _verifyAndConsumeWalletOperationReplay(
		mapping(address => uint256) storage walletOperationNonces,
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature
	) internal {
		if (signedOp.replayAttackHeader.deadline != 0 && signedOp.replayAttackHeader.deadline < block.timestamp) {
			revert IGaslessLayer.WalletOperationExpired(signedOp.replayAttackHeader.deadline);
		}

		bytes32 opHash = _getWalletOperationHash(signedOp);
		if (!SignatureChecker.isValidSignatureNow(signedOp.signer, opHash, signature)) revert IGaslessLayer.InvalidWalletOperationSignature();

		uint256 expectedNonce = walletOperationNonces[signedOp.signerAccount.addr] + 1;
		if (signedOp.replayAttackHeader.nonce != expectedNonce) {
			revert IGaslessLayer.WalletOperationInvalidNonce(signedOp.signerAccount.addr, expectedNonce, signedOp.replayAttackHeader.nonce);
		}
		walletOperationNonces[signedOp.signerAccount.addr] = expectedNonce;
	}

	// ────────────────────────── Call Data ─────────────────────────

	function _decodeWalletExecuteCalls(bytes memory callData) internal pure returns (GaslessWallet.Call[] memory calls) {
		if (callData.length < 4) revert IGaslessLayer.WalletCallDataTooShort();
		bytes4 selector = _selectorFromMemory(callData);
		if (selector != GaslessWallet.execute.selector) revert IGaslessLayer.InvalidWalletExecuteSelector(selector);

		bytes memory args = new bytes(callData.length - 4);
		for (uint256 i = 4; i < callData.length; i++) {
			args[i - 4] = callData[i];
		}
		calls = abi.decode(args, (GaslessWallet.Call[]));
	}

	// ─────────────────────── Account Lookup ───────────────────────

	function _walletOwnerForOperation(
		ISymmioAccountLayer accountLayer,
		IInstantLayer.SignedOperation calldata signedOp
	) internal view returns (address ownerWallet, address canonicalAccount) {
		if (signedOp.signerAccount.isPartyB) revert IGaslessLayer.WalletOperationForPartyBUnsupported();
		canonicalAccount = _resolveCanonicalAccount(accountLayer, signedOp.signerAccount.addr);
		ownerWallet = _ownerWalletForCanonicalAccount(accountLayer, canonicalAccount);
	}

	function _ownerWalletForCanonicalAccount(ISymmioAccountLayer accountLayer, address canonicalAccount) internal view returns (address ownerWallet) {
		try accountLayer.ownerOf(canonicalAccount) returns (address owner) {
			return owner == address(0) ? canonicalAccount : owner;
		} catch {
			return canonicalAccount;
		}
	}

	function _isWalletOperation(ISymmioAccountLayer accountLayer, IInstantLayer.SignedOperation calldata signedOp) internal view returns (bool) {
		address canonicalAccount = _resolveCanonicalAccount(accountLayer, signedOp.signerAccount.addr);
		address ownerWallet = _ownerWalletForCanonicalAccount(accountLayer, canonicalAccount);
		return signedOp.target == GaslessWalletDeployerLib.getGaslessWalletAddress(ownerWallet);
	}

	// ─────────────────────── Authorization ────────────────────────

	function _assertWalletAuthority(
		IInstantLayer instantLayer,
		IInstantLayer.SignedOperation calldata signedOp,
		address ownerWallet,
		address canonicalAccount,
		GaslessWallet.Call[] memory calls
	) internal view {
		if (signedOp.signer == ownerWallet) return;

		_assertInstantDelegation(instantLayer, canonicalAccount, signedOp.signer, WALLET_EXECUTION_SENTINEL_SELECTOR);
		for (uint256 i = 0; i < calls.length; i++) {
			bytes4 selector = _selectorFromMemory(calls[i].data);
			_assertInstantDelegation(instantLayer, canonicalAccount, signedOp.signer, selector);
		}
	}

	function _assertInstantDelegation(IInstantLayer instantLayer, address delegator, address delegate, bytes4 selector) internal view {
		if (!instantLayer.isDelegationActive(delegator, delegate, selector)) {
			revert IGaslessLayer.WalletDelegationMissing(delegator, delegate, selector);
		}
	}

	/// @dev Authorization identity, not billing identity: only a live VA rolls up to its parent, so a
	///      deleted VA address cannot widen wallet ownership or delegation scope to the parent.
	function _resolveCanonicalAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		return GaslessBillingIdentity.resolveCanonicalAccount(accountLayer, account);
	}

	function _selectorFromCalldata(bytes calldata callData) internal pure returns (bytes4) {
		if (callData.length < 4) return bytes4(0);
		return bytes4(callData[:4]);
	}

	function _selectorFromMemory(bytes memory data) internal pure returns (bytes4 selector) {
		if (data.length < 4) return bytes4(0);
		assembly ("memory-safe") {
			selector := mload(add(data, 32))
		}
	}
}
