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
import { IVirtualProvider } from "../../interfaces/IVirtualProvider.sol";
import { IExpressProvider } from "../../interfaces/IExpressProvider.sol";

library WithdrawFacetImpl {
	using SafeERC20 for IERC20;
	event Withdraw(address sender, address user, uint256 amount);

	function initiateWithdraw(
		WithdrawReceiverPart[] memory parts,
		bytes memory data
	) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		address collateral = appLayout.collateral;
		uint256 collateralDecimals = IERC20Metadata(collateral).decimals();

		require(parts.length > 0, "No withdraw parts");
		require(parts.length <= withdrawLayout.maxWithdrawParts, "Too many withdraw parts");

		uint256 totalAmount;

		// Provider tracking
		address expressProvider;
		address virtualProvider;

		bool hasExpress;
		bool hasVirtual;

		for (uint256 i = 0; i < parts.length; i++) {
			WithdrawReceiverPart memory part = parts[i];
			require(part.amount > 0, 'Withdraw request part should have amount greater than 0.');
			bool isExpress = part.expressProvider != address(0);
			bool isVirtual = part.virtualProvider != address(0);

			// EXPRESS HANDLING
			if (isExpress) {
				if (!hasExpress) {
					// First express part — lock provider
					expressProvider = part.expressProvider;
					hasExpress = true;
				} else {
					// Ensure all express providers match
					require(
						expressProvider == part.expressProvider,
						"Multiple express providers not allowed"
					);
				}
			}

			// CHECK VIRTUAL IS REGISTER
			if (isVirtual){
				require(appLayout.virtualProviders[part.virtualProvider], "Not registered virtual provider");
			}

			// VIRTUAL HANDLING (only matters if NO express anywhere)
			if (!isExpress && isVirtual) {
				if (!hasVirtual) {
					virtualProvider = part.virtualProvider;
					hasVirtual = true;
				} else {
					require(
						virtualProvider == part.virtualProvider,
						"Multiple virtual providers not allowed"
					);
				}
			}

			totalAmount += part.amount;
		}
		if(hasExpress)
			require(appLayout.expressProviders[expressProvider], "Not registered express provider");
		// Convert user amount to 18 decimals
		uint256 totalAmountWith18 = (totalAmount * 1e18) / (10 ** collateralDecimals);
		require(
			accountLayout.balances[msg.sender] >= totalAmountWith18,
			"WithdrawFacet: Insufficient balance"
		);

		accountLayout.balances[msg.sender] -= totalAmountWith18;

		uint256 currentId = ++withdrawLayout.lastWithdrawRequestId[msg.sender];

		//
		// FINAL PROVIDER SELECTION (your rules)
		//
		address provider;
		bool isPureVirtual;

		if (hasExpress) {
			// Rule 1: Express exists → always wins
			provider = expressProvider;
			isPureVirtual = false;
		} else if (hasVirtual) {
			// Rule 2: Only virtual exists
			provider = virtualProvider;
			isPureVirtual = true;
		} else {
			// Rule 3: None
			provider = address(0);
			isPureVirtual = false;
		}

		WithdrawRequest memory withdrawRequest = WithdrawRequest({
			id: currentId,
			user: msg.sender,
			parts: parts,
			timestamp: block.timestamp,
			cooldownEndTime: block.timestamp + withdrawLayout.withdrawCooldownPeriod,
			status: WithdrawStatus.PENDING,
			provider: provider,
			isPureVirtual: isPureVirtual,
			providerData: data
		});

		withdrawLayout.withdrawRequests[msg.sender][currentId] = withdrawRequest;

		//
		// CALLBACKS
		//

		if (hasExpress) {
			// Notify only the express provider
			IExpressProvider(expressProvider).onWithdrawRequest(withdrawRequest, collateral);
		} else if (hasVirtual) {
			// Notify virtual provider only when there is no express
			IVirtualProvider(virtualProvider).onWithdrawRequest(withdrawRequest);
		}

		return currentId;
	}

	function finalizeWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		address collateral = appLayout.collateral;

		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "Invalid withdraw request ID");

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[user][requestId];

		require(block.timestamp >= withdrawRequest.cooldownEndTime, "Withdraw cooldown not over");
		if (withdrawRequest.provider == address(0)){
			require(
				withdrawRequest.status == WithdrawStatus.PENDING,
				"Invalid withdraw request status"
			);
		} else {
			require(
				withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
				withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
				"Invalid withdraw request status"
			);
		}

		uint256 totalExpressAmount;
		uint256 totalWithdrawalAmount;
		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];

			bool isExpress = withdrawal.expressProvider != address(0);
			bool isVirtual = withdrawal.virtualProvider != address(0);

			if (!isExpress && !isVirtual) {
				IERC20(collateral).safeTransfer(_bytesToAddress(withdrawal.receiver), withdrawal.amount);
				continue;
			}

			if (isExpress && !isVirtual) {
				totalExpressAmount += withdrawal.amount;
			}
			totalWithdrawalAmount += withdrawal.amount;
		}

		if (totalExpressAmount > 0){
			IERC20(collateral).safeTransfer(withdrawRequest.provider, totalExpressAmount);
			IExpressProvider(withdrawRequest.provider).onWithdrawComplete(withdrawRequest);
		}

		if (withdrawRequest.isPureVirtual) {
			IVirtualProvider(withdrawRequest.provider).onWithdrawComplete(withdrawRequest);
		}

		withdrawRequest.status = WithdrawStatus.COMPLETED;

		// Event wise old events should still be emitted here
		emit Withdraw(msg.sender, withdrawRequest.user,totalWithdrawalAmount );
	}

	function acceptWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();

		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "Invalid withdraw request ID");

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[user][requestId];

		require(withdrawRequest.user == user, "Invalid withdraw user");
		require(withdrawRequest.status == WithdrawStatus.PENDING, "Invalid withdraw request status");
		require(withdrawRequest.provider != address(0), "Only Virtual or Express withdraw needs to accept");
		require(msg.sender == withdrawRequest.provider, "Not allowed to accept withdrawal.");

		withdrawRequest.status = WithdrawStatus.PROVIDER_ACCEPTED;
	}

	function rejectWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		uint256 collateralDecimals = IERC20Metadata(GlobalAppStorage.layout().collateral).decimals();

		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "Invalid withdraw request ID");

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[user][requestId];

		require(withdrawRequest.user == user, "Invalid withdraw user");
		require(withdrawRequest.status == WithdrawStatus.PENDING, "Invalid withdraw request status");
		require(withdrawRequest.provider != address(0), "Only Virtual or Express withdraw needs to accept");
		require(msg.sender == withdrawRequest.provider, "Not allowed to accept withdrawal.");

		uint256 totalCancelAmount;
		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];
			totalCancelAmount += withdrawal.amount;
		}
		uint256 totalAmountWith18Decimals = (totalCancelAmount * 1e18) / (10 ** collateralDecimals);
		accountLayout.balances[withdrawRequest.user] += totalAmountWith18Decimals;

		withdrawRequest.status = WithdrawStatus.PROVIDER_REJECTED;
	}

	function requestCancelWithdraw(uint256 requestId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

		require(requestId <= withdrawLayout.lastWithdrawRequestId[msg.sender], "Invalid withdraw request ID");

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[msg.sender][requestId];

		require(withdrawRequest.user == msg.sender, "Not withdraw request owner");

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
			withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED,
			"Invalid withdraw request status"
		);

		uint256 totalCancelAmount;
		bool hasProvider;
		address expressProvider;
		address pureVirtualProvider;
		if (withdrawRequest.status == WithdrawStatus.PENDING) {
			withdrawRequest.status = WithdrawStatus.CANCELLED;
			for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
				WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];
				totalCancelAmount += withdrawal.amount;
			}
			uint256 totalAmountWith18Decimals = (totalCancelAmount * 1e18) / (10 ** collateralDecimals);
			accountLayout.balances[withdrawRequest.user] += totalAmountWith18Decimals;
		} else {
			// Status Update
			withdrawRequest.status = WithdrawStatus.CANCEL_REQUESTED;

			// Callback to provider
			if(!withdrawRequest.isPureVirtual)
				IExpressProvider(withdrawRequest.provider).onWithdrawCancelRequest(withdrawRequest);
			else {
				IVirtualProvider(withdrawRequest.provider).onWithdrawCancelRequest(withdrawRequest);
			}
		}
	}

	function forceCancelWithdraw(uint256 requestId) internal {
		// it is for virtual withdrawal users to force cancel after cooldown
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

		require(requestId <= withdrawLayout.lastWithdrawRequestId[msg.sender], "Invalid withdraw request ID");

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[msg.sender][requestId];
		require(withdrawRequest.isPureVirtual, "Not a pure virtual withdraw");
		require(withdrawRequest.user == msg.sender, "Not withdraw request owner");
		require(withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED, "Invalid withdraw request status");
		require(block.timestamp >= withdrawRequest.cooldownEndTime, "Withdraw cooldown not over");

		uint256 totalAmount;

		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];
			totalAmount += withdrawal.amount;
		}

		withdrawRequest.status = WithdrawStatus.CANCELLED;

		uint256 totalAmountWith18Decimals = (totalAmount * 1e18) / (10 ** collateralDecimals);
		accountLayout.balances[withdrawRequest.user] += totalAmountWith18Decimals;

		IVirtualProvider(withdrawRequest.provider).onForceWithdrawCancel(withdrawRequest);
	}

	function acceptWithdrawCancelRequest(address user, uint256 requestId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		uint256 collateralDecimals = IERC20Metadata(appLayout.collateral).decimals();

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[user][requestId];

		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "Invalid withdraw request ID");

		require(withdrawRequest.user == user, "Invalid withdraw user");
		require(withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED, "Invalid withdraw request status");
		require(msg.sender == withdrawRequest.provider, "Not allowed to accept cancel.");

		uint256 totalAmount;

		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];
			totalAmount += withdrawal.amount;
		}

		uint256 amountWith18 = (totalAmount * 1e18) / (10 ** collateralDecimals);
		accountLayout.balances[withdrawRequest.user] += amountWith18;

		withdrawRequest.status = WithdrawStatus.CANCELLED;
	}

	function suspendWithdrawRequest(address user, uint256 requestId) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		uint256 collateralDecimals = IERC20Metadata(GlobalAppStorage.layout().collateral).decimals();

		require(accountLayout.suspendedAddresses[user], "User is not suspended");
		require(requestId <= withdrawLayout.lastWithdrawRequestId[user], "Invalid withdraw request ID");

		WithdrawRequest storage withdrawRequest = withdrawLayout.withdrawRequests[user][requestId];

		require(
			withdrawRequest.status == WithdrawStatus.PENDING ||
			withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED ||
			withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED,
			"Invalid withdraw request status"
		);

		uint256 totalAmount;

		for (uint256 i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart storage withdrawal = withdrawRequest.parts[i];
			totalAmount += withdrawal.amount;
		}

		uint256 amountWith18 = (totalAmount * 1e18) / (10 ** collateralDecimals);
		accountLayout.balances[withdrawRequest.user] += amountWith18;
		withdrawRequest.status = WithdrawStatus.SUSPENDED;
	}

	function _bytesToAddress(bytes memory data) internal pure returns (address addr) {
		require(data.length == 20, "Invalid address bytes length");
		assembly {
			addr := shr(96, mload(add(data, 32)))
		}
	}
}
