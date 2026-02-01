// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
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

	function initiateWithdraw(WithdrawReceiverPart[] memory parts, bool speedUp, bytes memory data) internal returns (uint256) {
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
			IERC20Metadata(collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >= (locals.totalAmount - locals.totalVirtualAmount),
			"WithdrawFacet : Insufficient contract collateral"
		);

		withdrawLayout.withdrawLockedBalance += (locals.totalAmount - locals.totalVirtualAmount);
		accountLayout.balances[signer] -= totalAmountWith18;

		uint256 currentId = ++withdrawLayout.lastWithdrawRequestId[signer];

		// Final provider selection
		(address provider, bool isPureVirtual) = _selectProvider(locals, speedUp);

		WithdrawRequest memory withdrawRequest = WithdrawRequest({
			id: currentId,
			user: signer,
			parts: parts,
			timestamp: block.timestamp,
			cooldownEndTime: block.timestamp + withdrawLayout.withdrawCooldownPeriod,
			status: WithdrawStatus.PENDING,
			speedUp: speedUp,
			isCooldownModified: false,
			provider: provider,
			isPureVirtual: isPureVirtual,
			providerData: data,
			totalAmount: locals.totalAmount,
			totalVirtualAmount: locals.totalVirtualAmount
		});

		withdrawLayout.withdrawRequests[signer][currentId] = withdrawRequest;

		// Provider callbacks
		if (locals.hasExpress) {
			LibSafeCall.safeExternalCall(locals.expressProvider, abi.encodeCall(IExpressProvider.onWithdrawRequest, (withdrawRequest, collateral)));
		} else if (locals.hasVirtual) {
			LibSafeCall.safeExternalCall(locals.virtualProvider, abi.encodeCall(IVirtualProvider.onWithdrawRequest, (withdrawRequest)));
		}

		return currentId;
	}

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
			if (totalExpressAmount > 0) {
				LibSafeERC20.safeTransfer(collateral, withdrawRequest.provider, totalExpressAmount);
				withdrawLayout.withdrawLockedBalance -= totalExpressAmount;
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

	function acceptWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.PENDING, "WithdrawFacet : Invalid withdraw request status");
		require(withdrawRequest.provider != address(0), "WithdrawFacet : Only Virtual or Express withdraw needs to accept");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to accept withdrawal");

		withdrawRequest.status = WithdrawStatus.PROVIDER_ACCEPTED;
	}

	function rejectWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.PENDING, "WithdrawFacet : Invalid withdraw request status");
		require(withdrawRequest.provider != address(0), "WithdrawFacet : Only Virtual or Express withdraw needs to accept");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to accept withdrawal");

		_unlockAndRefund(withdrawRequest);

		withdrawRequest.status = WithdrawStatus.PROVIDER_REJECTED;
	}

	function requestCancelWithdraw(uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(LibSigner.getSigner(), requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING || withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED,
			"WithdrawFacet : Invalid withdraw request status"
		);

		if (withdrawRequest.isPureVirtual) {
			uint256 cancelWindow = withdrawLayout.pureVirtualWithdrawCancelWindow;
			if (cancelWindow > 0) {
				require(block.timestamp + cancelWindow < withdrawRequest.cooldownEndTime, "WithdrawFacet : Cancel window passed");
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

	function forceCancelWithdraw(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
				withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
				withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(block.timestamp < withdrawRequest.cooldownEndTime, "WithdrawFacet : Withdraw cooldown already over");

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.CANCELLED;

		if (withdrawRequest.provider != address(0)) {
			if (withdrawRequest.isPureVirtual) {
				LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IVirtualProvider.onForceWithdrawCancel, (withdrawRequest)));
			} else {
				LibSafeCall.safeExternalCall(withdrawRequest.provider, abi.encodeCall(IExpressProvider.onWithdrawCancelRequest, (withdrawRequest)));
			}
		}
	}

	function acceptWithdrawCancelRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED, "WithdrawFacet : Invalid withdraw request status");
		require(msg.sender == withdrawRequest.provider, "WithdrawFacet : Not allowed to accept cancel");

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.CANCELLED;
	}

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

	function _getWithdrawRequest(address user, uint256 requestId) internal view returns (WithdrawRequest storage) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "WithdrawFacet : Invalid withdraw request ID");

		return withdrawLayout.withdrawRequests[user][requestId];
	}

	function _unlockAndRefund(WithdrawRequest storage withdrawRequest) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

		withdrawLayout.withdrawLockedBalance -= (withdrawRequest.totalAmount - withdrawRequest.totalVirtualAmount);

		uint256 amountWith18 = _to18Decimals(withdrawRequest.totalAmount, collateralDecimals);
		accountLayout.balances[withdrawRequest.user] += amountWith18;
	}

	function _to18Decimals(uint256 amount, uint256 collateralDecimals) internal pure returns (uint256) {
		if (collateralDecimals == 18) return amount;
		return (amount * 1e18) / (10 ** collateralDecimals);
	}

	function _bytesToAddress(bytes memory data) internal pure returns (address) {
		require(data.length == 20, "WithdrawFacet : Invalid address bytes length");
		return address(uint160(bytes20(data)));
	}
}
