// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer } from "../interfaces/ISymmioAccountLayer.sol";
import { GaslessBillingIdentity } from "./GaslessBillingIdentity.sol";
import { GaslessLayerDomain } from "./GaslessLayerDomain.sol";

/// @title GaslessNativeGasTopUpLib
/// @notice Linked native-gas top-up implementation for GaslessLayer.
/// @dev This library is called through Solidity's linked-library delegatecall path. That keeps
///      `address(this)`, `msg.sender`, and `msg.value` in the gateway/proxy context, which is required
///      for the EIP-712 verifying contract, native transfer source, and storage writes to stay stable.
library GaslessNativeGasTopUpLib {
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;
	bytes32 internal constant NATIVE_GAS_TOP_UP_TYPEHASH = keccak256(
		"NativeGasTopUpRequest(address payerAccount,address recipientWallet,uint256 collateralAmount,uint256 minNativeAmountOut,uint256 nonce,uint256 deadline)"
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
		_verifyNativeGasTopUpSignature(accountLayerContract, request, payer, signature);
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
			ISymmioCore(core).chargeOperationalFee(payer, totalCollateralCharge);
		}

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

	function _verifyNativeGasTopUpSignature(
		ISymmioAccountLayer accountLayer,
		IGaslessLayer.NativeGasTopUpRequest calldata request,
		address payer,
		bytes calldata signature
	) internal view {
		address recovered = ECDSA.recover(_nativeGasTopUpDigest(request), signature);
		if (recovered != _expectedNativeGasTopUpSigner(accountLayer, request.payerAccount, payer)) {
			revert IGaslessLayer.InvalidNativeGasTopUpSignature();
		}
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
