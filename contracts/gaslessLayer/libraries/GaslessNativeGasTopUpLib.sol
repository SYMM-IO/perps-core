// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer } from "../interfaces/ISymmioAccountLayer.sol";
import { GaslessBillingIdentity } from "./GaslessBillingIdentity.sol";
import { GaslessLayerDomain } from "./GaslessLayerDomain.sol";
import { GaslessFeeAccounting } from "./GaslessFeeAccounting.sol";

/// @title GaslessNativeGasTopUpLib
/// @notice Linked native-gas top-up implementation for GaslessLayer.
/// @dev The gateway calls this linked library through delegatecall, preserving `address(this)`, `msg.sender`, and `msg.value`.
///      The gateway proxy is the EIP-712 verifying contract, sends the native funds, and holds the updated storage.
library GaslessNativeGasTopUpLib {
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;
	/// @dev Passed as `maxTotalCharge` when the user signed the uncapped NativeGasTopUpRequest type.
	uint256 internal constant UNCAPPED_TOTAL_CHARGE = type(uint256).max;
	bytes32 internal constant NATIVE_GAS_TOP_UP_TYPEHASH = keccak256(
		"NativeGasTopUpRequest(address payerAccount,address recipientWallet,uint256 collateralAmount,uint256 minNativeAmountOut,uint256 nonce,uint256 deadline)"
	);
	bytes32 internal constant CAPPED_NATIVE_GAS_TOP_UP_TYPEHASH = keccak256(
		"CappedNativeGasTopUpRequest(address payerAccount,address recipientWallet,uint256 collateralAmount,uint256 minNativeAmountOut,uint256 nonce,uint256 deadline,uint256 maxTotalCharge)"
	);

	struct NativeGasTopUpResult {
		address payer;
		uint256 totalCollateralCharge;
		bool sponsored;
		uint256 sponsoredUsedToday;
		uint256 sponsoredLimit;
	}

	// ───────────────────── External Entrypoints ───────────────────

	function relayNativeGasTopUp(
		mapping(address => uint256) storage topUpNonces,
		mapping(address => IGaslessLayer.DailyNativeSponsorUsage) storage dailyNativeSponsorUsage,
		address accountLayer,
		address core,
		uint256 dailySponsoredNativeLimit,
		bool revertWhenNativeSponsorLimitExhausted,
		uint256 maxNativeGasTopUpAmount,
		uint256 nativeGasTopUpFeeBps,
		IGaslessLayer.NativeGasTopUpRequest calldata request,
		uint256 maxTotalCharge,
		bytes calldata signature
	) external returns (NativeGasTopUpResult memory result) {
		if (request.recipientWallet == address(0)) revert IGaslessLayer.ZeroAddress();
		if (request.collateralAmount == 0) revert IGaslessLayer.NativeGasTopUpCollateralAmountZero();
		if (msg.value == 0) revert IGaslessLayer.NativeGasTopUpAmountZero();
		if (msg.value < request.minNativeAmountOut) revert IGaslessLayer.NativeGasTopUpAmountBelowMin(msg.value, request.minNativeAmountOut);
		if (msg.value > maxNativeGasTopUpAmount) revert IGaslessLayer.NativeGasTopUpAmountExceedsMax(msg.value, maxNativeGasTopUpAmount);
		if (block.timestamp > request.deadline) revert IGaslessLayer.NativeGasTopUpExpired(request.deadline);

		ISymmioAccountLayer accountLayerContract = ISymmioAccountLayer(accountLayer);
		address payer = _resolveBillingAccount(accountLayerContract, request.payerAccount);
		_verifyNativeGasTopUpSignature(accountLayerContract, request, payer, maxTotalCharge, signature);
		_consumeTopUpNonce(topUpNonces, request);

		(bool sponsored, uint256 sponsoredUsedToday) = _useSponsoredNativeGas(
			dailyNativeSponsorUsage,
			payer,
			msg.value,
			dailySponsoredNativeLimit,
			revertWhenNativeSponsorLimitExhausted
		);
		uint256 totalCollateralCharge;
		if (!sponsored) {
			(, totalCollateralCharge) = getNativeGasTopUpCharge(request.collateralAmount, nativeGasTopUpFeeBps);
			if (totalCollateralCharge > maxTotalCharge) revert IGaslessLayer.FeeLimitExceeded(totalCollateralCharge, maxTotalCharge);
			ISymmioCore(core).chargeOperationalFee(payer, totalCollateralCharge);
		}
		GaslessFeeAccounting.record(
			IGaslessLayer.FeePayment(
				request.payerAccount,
				payer,
				uint8(IGaslessLayer.FeeSource.SYMMIO_ACCOUNT),
				0,
				0,
				0,
				sponsored ? 0 : totalCollateralCharge - request.collateralAmount,
				sponsored ? 0 : request.collateralAmount
			)
		);
		if (sponsored) GaslessFeeAccounting.sponsored();

		_sendNativeGas(request.recipientWallet, msg.value);
		return
			NativeGasTopUpResult({
				payer: payer,
				totalCollateralCharge: totalCollateralCharge,
				sponsored: sponsored,
				sponsoredUsedToday: sponsoredUsedToday,
				sponsoredLimit: dailySponsoredNativeLimit
			});
	}

	function getNativeGasTopUpCharge(
		uint256 collateralAmount,
		uint256 nativeGasTopUpFeeBps
	) public pure returns (uint256 feeAmount, uint256 totalCollateralCharge) {
		feeAmount = (collateralAmount * nativeGasTopUpFeeBps) / FEE_MULTIPLIER_BASE;
		totalCollateralCharge = collateralAmount + feeAmount;
	}

	// ─────────────────────────── EIP-712 ──────────────────────────

	function _nativeGasTopUpDigest(IGaslessLayer.NativeGasTopUpRequest calldata request) internal view returns (bytes32) {
		bytes32 structHash = keccak256(
			abi.encode(
				NATIVE_GAS_TOP_UP_TYPEHASH,
				request.payerAccount,
				request.recipientWallet,
				request.collateralAmount,
				request.minNativeAmountOut,
				request.nonce,
				request.deadline
			)
		);
		return GaslessLayerDomain.hashTypedData(structHash);
	}

	function _expectedNativeGasTopUpSigner(ISymmioAccountLayer accountLayer, address payerAccount, address payer) internal view returns (address) {
		try accountLayer.ownerOf(payer) returns (address owner) {
			return owner == address(0) ? payerAccount : owner;
		} catch {
			return payerAccount;
		}
	}

	/// @dev The cap travels as an explicit argument rather than inside the signature bytes, so the signature is passed
	///      to the signer untouched. That lets smart accounts validate their own variable-length formats through ERC-1271.
	function _verifyNativeGasTopUpSignature(
		ISymmioAccountLayer accountLayer,
		IGaslessLayer.NativeGasTopUpRequest calldata request,
		address payer,
		uint256 maxTotalCharge,
		bytes calldata signature
	) internal view {
		bytes32 digest =
			maxTotalCharge == UNCAPPED_TOTAL_CHARGE ? _nativeGasTopUpDigest(request) : _cappedNativeGasTopUpDigest(request, maxTotalCharge);
		address expectedSigner = _expectedNativeGasTopUpSigner(accountLayer, request.payerAccount, payer);
		if (!SignatureChecker.isValidSignatureNowCalldata(expectedSigner, digest, signature)) {
			revert IGaslessLayer.InvalidNativeGasTopUpSignature();
		}
	}

	function _cappedNativeGasTopUpDigest(
		IGaslessLayer.NativeGasTopUpRequest calldata request,
		uint256 maxTotalCharge
	) internal view returns (bytes32) {
		return
			GaslessLayerDomain.hashTypedData(
				keccak256(
					abi.encode(
						CAPPED_NATIVE_GAS_TOP_UP_TYPEHASH,
						request.payerAccount,
						request.recipientWallet,
						request.collateralAmount,
						request.minNativeAmountOut,
						request.nonce,
						request.deadline,
						maxTotalCharge
					)
				)
			);
	}

	// ─────────────────────────── Storage ──────────────────────────

	function _consumeTopUpNonce(mapping(address => uint256) storage topUpNonces, IGaslessLayer.NativeGasTopUpRequest calldata request) internal {
		uint256 expectedNonce = topUpNonces[request.payerAccount];
		if (request.nonce != expectedNonce) {
			revert IGaslessLayer.NativeGasTopUpNonceMismatch(request.payerAccount, expectedNonce, request.nonce);
		}
		topUpNonces[request.payerAccount] = expectedNonce + 1;
	}

	function _useSponsoredNativeGas(
		mapping(address => IGaslessLayer.DailyNativeSponsorUsage) storage dailyNativeSponsorUsage,
		address payer,
		uint256 nativeAmount,
		uint256 limit,
		bool revertWhenNativeSponsorLimitExhausted
	) internal returns (bool covered, uint256 nextUsed) {
		uint64 today = uint64(block.timestamp / 1 days);
		IGaslessLayer.DailyNativeSponsorUsage memory usage = dailyNativeSponsorUsage[payer];
		uint256 usedToday = usage.day == today ? usage.amount : 0;
		nextUsed = usedToday + nativeAmount;
		if (nextUsed > limit || nextUsed > type(uint192).max) {
			if (revertWhenNativeSponsorLimitExhausted) revert IGaslessLayer.DailySponsoredNativeLimitExceeded(payer, limit);
			return (false, usedToday);
		}
		dailyNativeSponsorUsage[payer] = IGaslessLayer.DailyNativeSponsorUsage({ day: today, amount: uint192(nextUsed) });
		return (true, nextUsed);
	}

	// ─────────────────────────── Helpers ──────────────────────────

	function _resolveBillingAccount(ISymmioAccountLayer accountLayer, address account) internal view returns (address) {
		return GaslessBillingIdentity.resolveBillingAccount(accountLayer, account);
	}

	function _sendNativeGas(address recipient, uint256 amount) internal {
		(bool ok, ) = recipient.call{ value: amount }("");
		if (!ok) revert IGaslessLayer.NativeGasTransferFailed(recipient, amount);
	}
}
