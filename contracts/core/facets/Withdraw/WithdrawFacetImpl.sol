// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { WithdrawStorage, WithdrawReceiverPart, WithdrawRequest, WithdrawStatus } from "../../storages/WithdrawStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { IVirtualProvider } from "../../interfaces/IVirtualProvider.sol";
import { IExpressProvider } from "../../interfaces/IExpressProvider.sol";
import { LibSafeCall } from "../../libraries/LibSafeCall.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";

library WithdrawFacetImpl {
	event Withdraw(address sender, address user, uint256 amount);

	struct InitiateWithdrawLocals {
		address expressProvider;
		address virtualProvider;
		bool hasExpress;
		bool hasVirtual;
		uint256 totalAmount;
		uint256 totalVirtualAmount;
	}

	/// @notice Creates a new withdrawal request, debiting the caller's balance and notifying providers
	function initiateWithdraw(WithdrawReceiverPart[] memory parts, bool speedUp, bytes memory data) internal returns (uint256, uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		address signer = LibSigner.getSigner();
		address collateral = appLayout.collateral;

		require(parts.length > 0, "WithdrawFacet : No withdraw parts");
		require(parts.length <= withdrawLayout.maxWithdrawParts, "WithdrawFacet : Too many withdraw parts");

		if (speedUp) {
			require(withdrawLayout.speedUpWhitelist[signer], "WithdrawFacet : Not allowed to speed up withdraw");
		}

		InitiateWithdrawLocals memory locals = _processWithdrawParts(parts, withdrawLayout);

		if (locals.hasExpress) {
			require(withdrawLayout.expressProviders[locals.expressProvider], "WithdrawFacet : Not registered express provider");
		}

		// Convert user amount to 18 decimals
		uint256 totalAmountWith18 = _to18Decimals(locals.totalAmount, IERC20Metadata(collateral).decimals());

		require(accountLayout.balances[signer] >= totalAmountWith18, "WithdrawFacet : Insufficient balance");

		require(
			IERC20Metadata(collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >=
				(locals.totalAmount - locals.totalVirtualAmount),
			"WithdrawFacet : Insufficient contract collateral"
		);

		withdrawLayout.withdrawLockedBalance += (locals.totalAmount - locals.totalVirtualAmount);
		accountLayout.balances[signer] -= totalAmountWith18;

		uint256 currentId = ++withdrawLayout.lastWithdrawRequestId[signer];

		// Final provider selection
		(address provider, bool isPureVirtual) = _selectProvider(locals, speedUp);

		// Cooldown: funds are non-withdrawable for withdrawCooldownPeriod after the last deallocate
		uint256 cooldownEndTime = accountLayout.deallocateTimestamp[signer] + MAStorage.layout().withdrawCooldownPeriod;
		if (cooldownEndTime < block.timestamp) {
			cooldownEndTime = block.timestamp;
		}

		WithdrawRequest memory withdrawRequest = WithdrawRequest({
			id: currentId,
			user: signer,
			parts: parts,
			timestamp: block.timestamp,
			cooldownEndTime: cooldownEndTime,
			status: WithdrawStatus.PENDING,
			speedUp: speedUp,
			isCooldownModified: false,
			provider: provider,
			isPureVirtual: isPureVirtual,
			providerData: data,
			totalAmount: locals.totalAmount,
			totalVirtualAmount: locals.totalVirtualAmount,
			advancedAmount: 0
		});

		withdrawLayout.withdrawRequests[signer][currentId] = withdrawRequest;

		// Provider callbacks
		if (locals.hasExpress) {
			LibSafeCall.safeExternalCall(locals.expressProvider, abi.encodeCall(IExpressProvider.onWithdrawRequest, (withdrawRequest, collateral)));
		} else if (locals.hasVirtual) {
			LibSafeCall.safeExternalCall(locals.virtualProvider, abi.encodeCall(IVirtualProvider.onWithdrawRequest, (withdrawRequest)));
		}

		return (currentId, cooldownEndTime);
	}

	/// @notice Validates and aggregates withdrawal parts, tracking provider and amount totals
	function _processWithdrawParts(
		WithdrawReceiverPart[] memory parts,
		WithdrawStorage.Layout storage withdrawLayout
	) private view returns (InitiateWithdrawLocals memory locals) {
		for (uint256 i = 0; i < parts.length; i++) {
			WithdrawReceiverPart memory part = parts[i];

			require(part.amount > 0, "WithdrawFacet : Not allowed withdrawal zero amount");

			bool isExpress = part.expressProvider != address(0);
			bool isVirtual = part.virtualProvider != address(0);

			locals.totalAmount += part.amount;

			// EXPRESS HANDLING
			if (isExpress) {
				if (!locals.hasExpress) {
					locals.expressProvider = part.expressProvider;
					locals.hasExpress = true;
				} else {
					require(locals.expressProvider == part.expressProvider, "WithdrawFacet : Multiple express providers not allowed");
				}
			}

			// VIRTUAL REGISTRATION CHECK
			if (isVirtual) {
				require(withdrawLayout.virtualProviders[part.virtualProvider], "WithdrawFacet : Not registered virtual provider");
				locals.totalVirtualAmount += part.amount;
			} else {
				require(part.chainId == int256(block.chainid), "WithdrawFacet : Invalid chainId for non-virtual part");
			}

			// PURE VIRTUAL HANDLING (only if no express anywhere)
			if (!isExpress && isVirtual) {
				if (!locals.hasVirtual) {
					locals.virtualProvider = part.virtualProvider;
					locals.hasVirtual = true;
				} else {
					require(locals.virtualProvider == part.virtualProvider, "WithdrawFacet : Multiple virtual providers not allowed");
				}
			}
		}
	}

	/// @notice Selects the dominant provider for the withdrawal request
	function _selectProvider(InitiateWithdrawLocals memory locals, bool speedUp) private pure returns (address provider, bool isPureVirtual) {
		if (locals.hasExpress) {
			require(!speedUp, "WithdrawFacet : Speed up not allowed with express");
			provider = locals.expressProvider;
			isPureVirtual = false;
		} else if (locals.hasVirtual) {
			provider = locals.virtualProvider;
			isPureVirtual = true;
		} else {
			provider = address(0);
			isPureVirtual = false;
		}
	}

	/// @notice Finalizes a withdrawal after cooldown, transferring funds to receivers and providers
	function finalizeWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		address collateral = appLayout.collateral;

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(block.timestamp >= withdrawRequest.cooldownEndTime, "WithdrawFacet : Withdraw cooldown not over");

		if (withdrawRequest.provider == address(0)) {
			require(withdrawRequest.status == WithdrawStatus.PENDING, "WithdrawFacet : Invalid withdraw request status");
		} else {
			require(
				withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED || withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
				"WithdrawFacet : Invalid withdraw request status"
			);
		}

		uint256 totalExpressAmount;
		bool hasExpressPart;

		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];

			bool isExpress = withdrawal.expressProvider != address(0);
			bool isVirtual = withdrawal.virtualProvider != address(0);

			if (isExpress) {
				hasExpressPart = true;
			}

			// Classic withdraw
			if (!isExpress && !isVirtual) {
				LibSafeERC20.safeTransfer(collateral, _bytesToAddress(withdrawal.receiver), withdrawal.amount);
				withdrawLayout.withdrawLockedBalance -= withdrawal.amount;
				continue;
			}

			// Express only
			if (isExpress && !isVirtual) {
				totalExpressAmount += withdrawal.amount;
			}
		}

		if (hasExpressPart) {
			uint256 remainingExpress = totalExpressAmount - withdrawRequest.advancedAmount;
			if (remainingExpress > 0) {
				LibSafeERC20.safeTransfer(collateral, withdrawRequest.provider, remainingExpress);
				withdrawLayout.withdrawLockedBalance -= remainingExpress;
			}
			LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IExpressProvider.onWithdrawComplete, (withdrawRequest)));
		}

		if (withdrawRequest.isPureVirtual) {
			LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IVirtualProvider.onWithdrawComplete, (withdrawRequest)));
		}

		withdrawRequest.status = WithdrawStatus.COMPLETED;

		// Keep legacy event behavior
		emit Withdraw(LibSigner.getSigner(), withdrawRequest.user, withdrawRequest.totalAmount);
	}

	/// @notice Provider accepts a pending withdrawal request, marking it as PROVIDER_ACCEPTED
	function acceptWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.PENDING, "WithdrawFacet : Invalid withdraw request status");
		require(withdrawRequest.provider != address(0), "WithdrawFacet : Only Virtual or Express withdraw needs to accept");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to accept withdrawal");

		withdrawRequest.status = WithdrawStatus.PROVIDER_ACCEPTED;
	}

	/// @notice Provider advances locked collateral early, before cooldown expires.
	///         Used by express providers with credit lines to front funds to users.
	function advanceWithdraw(address user, uint256 requestId, uint256 amount) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED, "WithdrawFacet : Invalid withdraw request status");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to advance withdrawal");

		uint256 expressAmount = withdrawRequest.totalAmount - withdrawRequest.totalVirtualAmount;
		require(withdrawRequest.advancedAmount + amount <= expressAmount, "WithdrawFacet : Advance exceeds express amount");

		withdrawRequest.advancedAmount += amount;
		LibSafeERC20.safeTransfer(appLayout.collateral, msg.sender, amount);
		withdrawLayout.withdrawLockedBalance -= amount;
	}

	/// @notice Provider rejects a pending withdrawal request, refunding the user's balance
	function rejectWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.PENDING, "WithdrawFacet : Invalid withdraw request status");
		require(withdrawRequest.provider != address(0), "WithdrawFacet : Only Virtual or Express withdraw needs to reject");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to reject withdrawal");

		_unlockAndRefund(withdrawRequest);

		withdrawRequest.status = WithdrawStatus.PROVIDER_REJECTED;
	}

	/// @notice Requests cancellation of a withdrawal, immediately refunding classic/virtual parts
	function requestCancelWithdraw(uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(LibSigner.getSigner(), requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING || withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED,
			"WithdrawFacet : Invalid withdraw request status"
		);

		if (withdrawRequest.isPureVirtual) {
			uint256 blackout = withdrawLayout.pureVirtualCancelBlackout;
			if (blackout > 0) {
				require(block.timestamp + blackout < withdrawRequest.cooldownEndTime, "WithdrawFacet : Cancel blackout active");
			}
		}

		if (withdrawRequest.status == WithdrawStatus.PENDING) {
			_unlockAndRefund(withdrawRequest);
			withdrawRequest.status = WithdrawStatus.CANCELLED;
		} else {
			if (withdrawRequest.isPureVirtual) {
				_unlockAndRefund(withdrawRequest);
				withdrawRequest.status = WithdrawStatus.CANCELLED;
				LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IVirtualProvider.onWithdrawCancelRequest, (withdrawRequest)));
			} else {
				// Provider must handle cancel
				withdrawRequest.status = WithdrawStatus.CANCEL_REQUESTED;
				LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IExpressProvider.onWithdrawCancelRequest, (withdrawRequest)));
			}
		}
	}

	/// @notice Force-cancels a withdrawal before cooldown expiry, refunding and notifying providers
	function forceCancelWithdraw(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
				withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
				withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(block.timestamp < withdrawRequest.cooldownEndTime, "WithdrawFacet : Withdraw cooldown already over");

		require(withdrawRequest.isPureVirtual || withdrawRequest.provider == address(0), "WithdrawFacet : Use suspend for express withdrawals");

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.CANCELLED;

		if (withdrawRequest.provider != address(0)) {
			LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IVirtualProvider.onForceWithdrawCancel, (withdrawRequest)));
		}
	}

	/// @notice Provider accepts a cancellation request, refunding the user and marking as CANCELLED
	function acceptWithdrawCancelRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED, "WithdrawFacet : Invalid withdraw request status");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to accept cancel");

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.CANCELLED;
	}

	/// @notice Suspends a withdrawal request for a suspended user, refunding and notifying providers
	function suspendWithdrawRequest(address user, uint256 requestId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(accountLayout.suspendedAddresses[user], "WithdrawFacet : User is not suspended");

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
				withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
				withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"WithdrawFacet : Invalid withdraw request status"
		);

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.SUSPENDED;

		if (withdrawRequest.provider != address(0)) {
			if (!withdrawRequest.isPureVirtual) {
				LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IExpressProvider.onWithdrawSuspend, (withdrawRequest)));
			} else {
				LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IVirtualProvider.onWithdrawSuspend, (withdrawRequest)));
			}
		}
	}

	/// @notice Accepts a speed-up request, reducing the cooldown period for the withdrawal
	function acceptSpeedUpRequest(address user, uint256 requestId, uint256 newCooldown) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.speedUp, "WithdrawFacet : Withdraw request is not speed up");
		require(!withdrawRequest.isCooldownModified, "WithdrawFacet : Cooldown already modified");
		require(withdrawLayout.speedUpWhitelist[user], "WithdrawFacet : User not in speed up whitelist");
		require(
			withdrawRequest.status == WithdrawStatus.PENDING || withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(newCooldown >= withdrawLayout.minWithdrawCooldown, "WithdrawFacet : New cooldown exceeds min cooldown");

		withdrawRequest.cooldownEndTime = withdrawRequest.timestamp + newCooldown;
		withdrawRequest.isCooldownModified = true;

		if (withdrawRequest.isPureVirtual) {
			LibSafeCall.safeExternalCall(
				withdrawRequest.provider,
				abi.encodeCall(IVirtualProvider.onSpeedUpWithdrawRequest, (withdrawRequest, newCooldown))
			);
		}
	}

	// ----------------------
	// Internal helper utils
	// ----------------------

	/// @notice Retrieves a withdrawal request by user and ID, validating that the ID exists
	function _getWithdrawRequest(address user, uint256 requestId) internal view returns (WithdrawRequest storage) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "WithdrawFacet : Invalid withdraw request ID");

		return withdrawLayout.withdrawRequests[user][requestId];
	}

	/// @notice Unlocks the withdrawal locked balance and refunds the user's internal balance
	function _unlockAndRefund(WithdrawRequest storage withdrawRequest) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

		withdrawLayout.withdrawLockedBalance -= (withdrawRequest.totalAmount - withdrawRequest.totalVirtualAmount);

		uint256 amountWith18 = _to18Decimals(withdrawRequest.totalAmount, collateralDecimals);
		accountLayout.balances[withdrawRequest.user] += amountWith18;
	}

	/// @notice Converts an amount from collateral decimals to 18 decimals
	function _to18Decimals(uint256 amount, uint256 collateralDecimals) internal pure returns (uint256) {
		if (collateralDecimals == 18) return amount;
		return (amount * 1e18) / (10 ** collateralDecimals);
	}

	/// @notice Converts a 20-byte payload into an address
	function _bytesToAddress(bytes memory data) internal pure returns (address) {
		require(data.length == 20, "WithdrawFacet : Invalid address bytes length");
		return address(uint160(bytes20(data)));
	}
}
