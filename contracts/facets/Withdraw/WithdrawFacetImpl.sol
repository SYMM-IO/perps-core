// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../storages/AccountStorage.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../storages/MAStorage.sol";
import "../../storages/WithdrawStorage.sol";
import "../../libraries/LibSigner.sol";
import { IVirtualProvider } from "../../interfaces/IVirtualProvider.sol";
import { IExpressProvider } from "../../interfaces/IExpressProvider.sol";

library WithdrawFacetImpl {
	using SafeERC20 for IERC20;

	event Withdraw(address sender, address user, uint256 amount);

	function initiateWithdraw(
		WithdrawReceiverPart[] memory parts,
		bool speedUp,
		bytes memory data
	) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		address collateral = appLayout.collateral;
		uint256 collateralDecimals = IERC20Metadata(collateral).decimals();

		require(parts.length > 0, "WithdrawFacet : No withdraw parts");
		require(
			parts.length <= withdrawLayout.maxWithdrawParts,
			"WithdrawFacet : Too many withdraw parts"
		);

		uint256 totalAmount;
		uint256 totalVirtualAmount;

		// Provider tracking
		address expressProvider;
		address virtualProvider;
		bool hasExpress;
		bool hasVirtual;

		if (speedUp) {
			require(
				withdrawLayout.speedUpWhitelist[LibSigner.getSigner()],
				"WithdrawFacet : Not allowed to speed up withdraw"
			);
		}

		for (uint256 i = 0; i < parts.length; i++) {
			WithdrawReceiverPart memory part = parts[i];

			require(
				part.amount > 0,
				"WithdrawFacet : Not allowed withdrawal zero amount"
			);

			bool isExpress = part.expressProvider != address(0);
			bool isVirtual = part.virtualProvider != address(0);

			totalAmount += part.amount;

			// EXPRESS HANDLING
			if (isExpress) {
				if (!hasExpress) {
					expressProvider = part.expressProvider;
					hasExpress = true;
				} else {
					require(
						expressProvider == part.expressProvider,
						"WithdrawFacet : Multiple express providers not allowed"
					);
				}
			}

			// VIRTUAL REGISTRATION CHECK
			if (isVirtual) {
				require(
					appLayout.virtualProviders[part.virtualProvider],
					"WithdrawFacet : Not registered virtual provider"
				);
				totalVirtualAmount += part.amount;
			} else {
				require(part.chainId == int256(block.chainid), "WithdrawFacet : Invalid chainId for non-virtual part");
			}

			// PURE VIRTUAL HANDLING (only if no express anywhere)
			if (!isExpress && isVirtual) {
				if (!hasVirtual) {
					virtualProvider = part.virtualProvider;
					hasVirtual = true;
				} else {
					require(
						virtualProvider == part.virtualProvider,
						"WithdrawFacet : Multiple virtual providers not allowed"
					);
				}
			}
		}

		if (hasExpress) {
			require(
				appLayout.expressProviders[expressProvider],
				"WithdrawFacet : Not registered express provider"
			);
		}

		// Convert user amount to 18 decimals
		uint256 totalAmountWith18 = _to18Decimals(totalAmount, collateralDecimals);

		require(
			accountLayout.balances[LibSigner.getSigner()] >= totalAmountWith18,
			"WithdrawFacet : Insufficient balance"
		);

		require(
			IERC20Metadata(collateral).balanceOf(address(this)) -
			withdrawLayout.withdrawLockedBalance >=
			(totalAmount - totalVirtualAmount),
			"WithdrawFacet : Insufficient contract collateral"
		);

		withdrawLayout.withdrawLockedBalance += (totalAmount - totalVirtualAmount);
		accountLayout.balances[LibSigner.getSigner()] -= totalAmountWith18;

		uint256 currentId = ++withdrawLayout.lastWithdrawRequestId[LibSigner.getSigner()];

		// Final provider selection
		address provider;
		bool isPureVirtual;

		if (hasExpress) {
			require(!speedUp, "WithdrawFacet : Speed up not allowed with express");
			provider = expressProvider;
			isPureVirtual = false;
		} else if (hasVirtual) {
			provider = virtualProvider;
			isPureVirtual = true;
		} else {
			provider = address(0);
			isPureVirtual = false;
		}

		WithdrawRequest memory withdrawRequest = WithdrawRequest({
			id: currentId,
			user: LibSigner.getSigner(),
			parts: parts,
			timestamp: block.timestamp,
			cooldownEndTime: block.timestamp + withdrawLayout.withdrawCooldownPeriod,
			status: WithdrawStatus.PENDING,
			speedUp: speedUp,
			isCooldownModified: false,
			provider: provider,
			isPureVirtual: isPureVirtual,
			providerData: data,
			totalAmount: totalAmount,
			totalVirtualAmount: totalVirtualAmount
		});

		withdrawLayout.withdrawRequests[LibSigner.getSigner()][currentId] = withdrawRequest;

		// Provider callbacks
		if (hasExpress) {
			IExpressProvider(expressProvider).onWithdrawRequest(withdrawRequest, collateral);
		} else if (hasVirtual) {
			IVirtualProvider(virtualProvider).onWithdrawRequest(withdrawRequest);
		}

		return currentId;
	}

	function finalizeWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		address collateral = appLayout.collateral;

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			block.timestamp >= withdrawRequest.cooldownEndTime,
			"WithdrawFacet : Withdraw cooldown not over"
		);

		if (withdrawRequest.provider == address(0)) {
			require(
				withdrawRequest.status == WithdrawStatus.PENDING,
				"WithdrawFacet : Invalid withdraw request status"
			);
		} else {
			require(
				withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
				withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
				"WithdrawFacet : Invalid withdraw request status"
			);
		}

		uint256 totalExpressAmount;

		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];

			bool isExpress = withdrawal.expressProvider != address(0);
			bool isVirtual = withdrawal.virtualProvider != address(0);

			// Classic withdraw
			if (!isExpress && !isVirtual) {
				IERC20(collateral).safeTransfer(
					_bytesToAddress(withdrawal.receiver),
					withdrawal.amount
				);
				withdrawLayout.withdrawLockedBalance -= withdrawal.amount;
				continue;
			}

			// Express only
			if (isExpress && !isVirtual) {
				totalExpressAmount += withdrawal.amount;
			}
		}

		if (totalExpressAmount > 0) {
			IERC20(collateral).safeTransfer(withdrawRequest.provider, totalExpressAmount);
			withdrawLayout.withdrawLockedBalance -= totalExpressAmount;
			IExpressProvider(withdrawRequest.provider).onWithdrawComplete(withdrawRequest);
		}

		if (withdrawRequest.isPureVirtual) {
			IVirtualProvider(withdrawRequest.provider).onWithdrawComplete(withdrawRequest);
		}

		withdrawRequest.status = WithdrawStatus.COMPLETED;

		// Keep legacy event behavior
		emit Withdraw(LibSigner.getSigner(), withdrawRequest.user, withdrawRequest.totalAmount);
	}

	function acceptWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(
			withdrawRequest.provider != address(0),
			"WithdrawFacet : Only Virtual or Express withdraw needs to accept"
		);
		require(
			msg.sender == withdrawRequest.provider,
			"WithdrawFacet : Not allowed to accept withdrawal"
		);

		withdrawRequest.status = WithdrawStatus.PROVIDER_ACCEPTED;
	}

	function rejectWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(
			withdrawRequest.provider != address(0),
			"WithdrawFacet : Only Virtual or Express withdraw needs to accept"
		);
		require(
			msg.sender == withdrawRequest.provider,
			"WithdrawFacet : Not allowed to accept withdrawal"
		);

		_unlockAndRefund(withdrawRequest);

		withdrawRequest.status = WithdrawStatus.PROVIDER_REJECTED;
	}

	function requestCancelWithdraw(uint256 requestId) internal {

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(
			LibSigner.getSigner(),
			requestId
		);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
			withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED,
			"WithdrawFacet : Invalid withdraw request status"
		);

		if (withdrawRequest.status == WithdrawStatus.PENDING) {
			_unlockAndRefund(withdrawRequest);
			withdrawRequest.status = WithdrawStatus.CANCELLED;
		} else {
			// Provider must handle cancel
			withdrawRequest.status = WithdrawStatus.CANCEL_REQUESTED;

			if (!withdrawRequest.isPureVirtual) {
				IExpressProvider(withdrawRequest.provider).onWithdrawCancelRequest(
					withdrawRequest
				);
			} else {
				IVirtualProvider(withdrawRequest.provider).onWithdrawCancelRequest(
					withdrawRequest
				);
			}
		}
	}

	function forceCancelWithdraw(uint256 requestId) internal {

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(
			LibSigner.getSigner(),
			requestId
		);

		require(
			withdrawRequest.isPureVirtual,
			"WithdrawFacet : Not a pure virtual withdraw"
		);
		require(
			withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(
			block.timestamp >= withdrawRequest.cooldownEndTime,
			"WithdrawFacet : Withdraw cooldown not over"
		);

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.CANCELLED;

		IVirtualProvider(withdrawRequest.provider).onForceWithdrawCancel(
			withdrawRequest
		);
	}

	function acceptWithdrawCancelRequest(address user, uint256 requestId) internal {
		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(
			msg.sender == withdrawRequest.provider,
			"WithdrawFacet : Not allowed to accept cancel"
		);

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.CANCELLED;
	}

	function suspendWithdrawRequest(address user, uint256 requestId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(
			accountLayout.suspendedAddresses[user],
			"WithdrawFacet : User is not suspended"
		);

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
			withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
			withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"WithdrawFacet : Invalid withdraw request status"
		);

		_unlockAndRefund(withdrawRequest);
		withdrawRequest.status = WithdrawStatus.SUSPENDED;
	}

	function acceptSpeedUpRequest(
		address user,
		uint256 requestId,
		uint256 newCooldown
	) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		WithdrawRequest storage withdrawRequest = _getWithdrawRequest(user, requestId);

		require(
			withdrawRequest.speedUp,
			"WithdrawFacet : Withdraw request is not speed up"
		);
		require(
			!withdrawRequest.isCooldownModified,
			"WithdrawFacet : Cooldown already modified"
		);
		require(
			withdrawLayout.speedUpWhitelist[user],
			"WithdrawFacet : User not in speed up whitelist"
		);
		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
			withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED,
			"WithdrawFacet : Invalid withdraw request status"
		);
		require(
			newCooldown >= withdrawLayout.minWithdrawCooldown,
			"WithdrawFacet : New cooldown exceeds min cooldown"
		);

		withdrawRequest.cooldownEndTime = withdrawRequest.timestamp + newCooldown;
		withdrawRequest.isCooldownModified = true;

		if (withdrawRequest.isPureVirtual) {
			IVirtualProvider(withdrawRequest.provider).onSpeedUpWithdrawRequest(
				withdrawRequest,
				newCooldown
			);
		}
	}

	// ----------------------
	// Internal helper utils
	// ----------------------

	function _getWithdrawRequest(
		address user,
		uint256 requestId
	) internal view returns (WithdrawRequest storage) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		require(
			requestId <= withdrawLayout.lastWithdrawRequestId[user],
			"WithdrawFacet : Invalid withdraw request ID"
		);

		return withdrawLayout.withdrawRequests[user][requestId];
	}

	function _unlockAndRefund(WithdrawRequest storage withdrawRequest) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

		withdrawLayout.withdrawLockedBalance -= (
			withdrawRequest.totalAmount - withdrawRequest.totalVirtualAmount
		);

		uint256 amountWith18 = _to18Decimals(
			withdrawRequest.totalAmount,
			collateralDecimals
		);
		accountLayout.balances[withdrawRequest.user] += amountWith18;
	}

	function _to18Decimals(
		uint256 amount,
		uint256 collateralDecimals
	) internal pure returns (uint256) {
		if (collateralDecimals == 18) return amount;
		return (amount * 1e18) / (10 ** collateralDecimals);
	}

	function _bytesToAddress(bytes memory data) internal pure returns (address) {
		require(
			data.length == 20,
			"WithdrawFacet : Invalid address bytes length"
		);
		return address(uint160(bytes20(data)));
	}
}
