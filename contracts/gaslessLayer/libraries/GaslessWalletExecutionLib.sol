// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

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
/// @dev Entry points use address parameters for ABI tooling compatibility.
///      Delegatecall runs this library in the gateway proxy's context, preserving the EIP-712 domain,
///      CREATE2 deployer, and nonce storage.
library GaslessWalletExecutionLib {
	// ───────────────────────── Constants ──────────────────────────

	bytes32 public constant WALLET_ACCOUNT_TYPEHASH = keccak256("Account(address addr,bool isPartyB)");
	bytes32 public constant WALLET_REPLAY_HEADER_TYPEHASH = keccak256("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)");
	// Keep the original selector so existing delegation grants remain valid.
	bytes4 public constant WALLET_EXECUTION_SENTINEL_SELECTOR = bytes4(keccak256("GASLESSQ_WALLET_EXECUTION"));
	bytes32 internal constant WALLET_SIGNED_OPERATION_TYPEHASH = keccak256(
		abi.encodePacked(
			"SignedOperation(address signer,address target,bytes callData,Account signerAccount,ReplayAttackHeader replayAttackHeader)",
			"Account(address addr,bool isPartyB)",
			"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
		)
	);

	// ─────────────────────────── Types ────────────────────────────

	/// @notice Wallet execution output and the inner-call selectors used for subsequent fee calculation.
	struct WalletExecutionResult {
		bytes result;
		address owner;
		address wallet;
		uint256 callCount;
		bytes4[] feeSelectors;
	}

	// ───────────────────── External Entrypoints ───────────────────

	/// @notice Compute the EIP-712 digest of a GaslessWallet operation in gateway context.
	/// @param signedOp Wallet operation to hash.
	/// @return EIP-712 operation digest.
	function getWalletOperationHash(IInstantLayer.SignedOperation calldata signedOp) external view returns (bytes32) {
		return _getWalletOperationHash(signedOp);
	}

	/// @notice Check whether a wallet-operation signature is valid for its declared signer.
	/// @dev Checks the signature only; does not validate the target, nonce, deadline, or signer authority.
	/// @param signedOp Wallet operation whose digest is checked.
	/// @param signature Signature to verify.
	/// @return Whether the signature is valid for signedOp.signer.
	function isValidWalletOperationSignature(IInstantLayer.SignedOperation calldata signedOp, bytes calldata signature) external view returns (bool) {
		return SignatureChecker.isValidSignatureNow(signedOp.signer, _getWalletOperationHash(signedOp), signature);
	}

	/// @notice Check whether an operation targets the selected owner-derived GaslessWallet.
	/// @dev A mismatched positive index reverts; a mismatched index-zero target is an InstantLayer operation.
	/// @param accountLayer AccountLayer address used to resolve the wallet owner.
	/// @param signedOp Operation whose target is classified.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @return Whether the target matches the selected GaslessWallet.
	function isWalletOperation(address accountLayer, IInstantLayer.SignedOperation calldata signedOp, uint256 walletId) external view returns (bool) {
		return _isWalletOperation(ISymmioAccountLayer(accountLayer), signedOp, walletId);
	}

	/// @notice Identify the function selectors to price in a standalone operation quote.
	/// @dev Classifies the target before decoding. Relay execution returns selectors from its already-decoded calls.
	/// @param accountLayer AccountLayer address used to resolve the wallet owner.
	/// @param signedOp Operation whose fee selectors are identified.
	/// @param walletId Wallet index; zero also permits an ordinary InstantLayer target.
	/// @return selectors Inner selectors for a wallet operation or the outer selector for an InstantLayer operation.
	function quoteOperationalFeeSelectors(
		address accountLayer,
		IInstantLayer.SignedOperation calldata signedOp,
		uint256 walletId
	) external view returns (bytes4[] memory selectors) {
		if (!_isWalletOperation(ISymmioAccountLayer(accountLayer), signedOp, walletId)) {
			selectors = new bytes4[](1);
			selectors[0] = _selectorFromCalldata(signedOp.callData);
			return selectors;
		}
		return _walletCallSelectors(_decodeWalletExecuteCalls(signedOp.callData));
	}

	/// @notice Validate and execute a signed operation through the selected GaslessWallet.
	/// @dev The signed target binds the wallet index. Validates the owner-derived target, signature, replay state,
	///      and delegate authority before deployment or execution. Returns selectors from the decoded wallet calls.
	/// @param walletOperationNonces Nonce mapping selected by the gateway; index zero uses the original account mapping.
	/// @param accountLayer AccountLayer address used to resolve the wallet owner.
	/// @param instantLayer InstantLayer address used to check delegated authority.
	/// @param signedOp Wallet operation to execute.
	/// @param signature Signature authorizing signedOp.
	/// @param walletId Wallet index; zero selects the original wallet.
	/// @return execution Encoded call results, wallet identity, call count, and fee selectors.
	function executeWalletOperation(
		mapping(address => uint256) storage walletOperationNonces,
		address accountLayer,
		address instantLayer,
		IInstantLayer.SignedOperation calldata signedOp,
		bytes calldata signature,
		uint256 walletId
	) external returns (WalletExecutionResult memory execution) {
		(address owner, address canonicalAccount) = _walletOwnerForOperation(ISymmioAccountLayer(accountLayer), signedOp);
		_assertWalletTarget(owner, signedOp.target, walletId);
		_verifyAndConsumeWalletOperationReplay(walletOperationNonces, signedOp, signature);
		GaslessWallet.Call[] memory calls = _decodeWalletExecuteCalls(signedOp.callData);
		_assertWalletAuthority(IInstantLayer(instantLayer), signedOp, owner, canonicalAccount, calls);

		(GaslessWallet wallet, ) = GaslessWalletDeployerLib.getOrDeployGaslessWallet(owner, walletId);
		execution = WalletExecutionResult({
			result: abi.encode(wallet.execute(calls)),
			owner: owner,
			wallet: address(wallet),
			callCount: calls.length,
			feeSelectors: _walletCallSelectors(calls)
		});
	}

	/// @dev Extract selectors from the decoded wallet calls without resolving ownership or calculating fees.
	function _walletCallSelectors(GaslessWallet.Call[] memory calls) private pure returns (bytes4[] memory selectors) {
		selectors = new bytes4[](calls.length);
		for (uint256 i = 0; i < calls.length; i++) selectors[i] = _selectorFromMemory(calls[i].data);
	}

	/// @dev Require the target to match the CREATE2 address derived from the owner and wallet index.
	function _assertWalletTarget(address owner, address target, uint256 walletId) private view returns (address expected) {
		expected = GaslessWalletDeployerLib.getWalletAddress(owner, walletId);
		if (target != expected) revert IGaslessLayer.InvalidWalletOperationTarget(expected, target);
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
	) internal view returns (address owner, address canonicalAccount) {
		if (signedOp.signerAccount.isPartyB) revert IGaslessLayer.WalletOperationForPartyBUnsupported();
		canonicalAccount = _resolveCanonicalAccount(accountLayer, signedOp.signerAccount.addr);
		owner = _ownerForCanonicalAccount(accountLayer, canonicalAccount);
	}

	function _ownerForCanonicalAccount(ISymmioAccountLayer accountLayer, address canonicalAccount) internal view returns (address owner) {
		try accountLayer.ownerOf(canonicalAccount) returns (address accountOwner) {
			return accountOwner == address(0) ? canonicalAccount : accountOwner;
		} catch {
			return canonicalAccount;
		}
	}

	/// @dev A positive index explicitly selects a wallet. Reject mismatched targets instead of
	///      routing them to InstantLayer. Index zero retains the existing target-based dispatch.
	function _isWalletOperation(
		ISymmioAccountLayer accountLayer,
		IInstantLayer.SignedOperation calldata signedOp,
		uint256 walletId
	) internal view returns (bool) {
		address canonicalAccount = _resolveCanonicalAccount(accountLayer, signedOp.signerAccount.addr);
		address owner = _ownerForCanonicalAccount(accountLayer, canonicalAccount);
		address expectedWallet = GaslessWalletDeployerLib.getWalletAddress(owner, walletId);
		bool matches = signedOp.target == expectedWallet;
		if (walletId != 0 && !matches) revert IGaslessLayer.InvalidWalletOperationTarget(expectedWallet, signedOp.target);
		return matches;
	}

	// ─────────────────────── Authorization ────────────────────────

	function _assertWalletAuthority(
		IInstantLayer instantLayer,
		IInstantLayer.SignedOperation calldata signedOp,
		address owner,
		address canonicalAccount,
		GaslessWallet.Call[] memory calls
	) internal view {
		if (signedOp.signer == owner) return;

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

	/// @dev Only a live VA resolves to its parent for authorization. A deleted VA cannot inherit
	///      the parent's wallet ownership or delegation authority.
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
