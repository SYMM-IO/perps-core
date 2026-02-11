// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { BridgeStorage, BridgeTransaction, BridgeTransactionStatus } from "../../storages/BridgeStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";

library BridgeFacetImpl {
	/// @notice Creates a bridge transaction record, deducting from the user's balance and locking collateral for withdrawal.
	function _createBridgeTransaction(address user, uint256 amount, address bridge) private returns (uint256 currentId) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		BridgeStorage.Layout storage bridgeLayout = BridgeStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address collateral = appLayout.collateral;
		require(bridgeLayout.bridges[bridge], "BridgeFacet: Invalid bridge");
		require(bridge != user, "BridgeFacet: Bridge and user can't be the same");

		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		require(accountLayout.balances[user] >= amountWith18Decimals, "BridgeFacet: Insufficient balance");

		currentId = ++bridgeLayout.lastId;
		BridgeTransaction memory bridgeTransaction = BridgeTransaction({
			id: currentId,
			amount: amount,
			user: user,
			bridge: bridge,
			timestamp: block.timestamp,
			status: BridgeTransactionStatus.RECEIVED
		});

		accountLayout.balances[user] -= amountWith18Decimals;

		// check enough balance in the contract
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		require(
			IERC20Metadata(collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >= amount,
			"Insufficient contract collateral"
		);
		withdrawLayout.withdrawLockedBalance += amount;

		bridgeLayout.bridgeTransactions[currentId] = bridgeTransaction;
		bridgeLayout.bridgeTransactionIds[bridge].push(currentId);
	}

	/// @notice Initiates a transfer to a bridge by creating a bridge transaction.
	function transferToBridge(address user, uint256 amount, address bridge) internal returns (uint256 currentId) {
		currentId = _createBridgeTransaction(user, amount, bridge);
	}

	/// @notice Allows a bridge to withdraw collateral for a single received transaction after the cooldown period.
	function withdrawReceivedBridgeValue(uint256 transactionId) internal {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		BridgeStorage.Layout storage bridgeLayout = BridgeStorage.layout();
		require(transactionId <= bridgeLayout.lastId, "BridgeFacet: Invalid transactionId");

		BridgeTransaction storage bridgeTransaction = bridgeLayout.bridgeTransactions[transactionId];

		require(bridgeTransaction.status == BridgeTransactionStatus.RECEIVED, "BridgeFacet: Already withdrawn");
		require(block.timestamp >= MAStorage.layout().withdrawCooldownPeriod + bridgeTransaction.timestamp, "BridgeFacet: Cooldown hasn't reached");
		if (bridgeLayout.bridges[bridgeTransaction.bridge]) {
			require(msg.sender == bridgeTransaction.bridge, "BridgeFacet: Sender is not the transaction's bridge");
			LibSafeERC20.safeTransfer(appLayout.collateral, bridgeTransaction.bridge, bridgeTransaction.amount);
		} else {
			revert("BridgeFacet: Invalid bridge");
		}

		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.withdrawLockedBalance -= bridgeTransaction.amount;

		bridgeTransaction.status = BridgeTransactionStatus.WITHDRAWN;
	}

	/// @notice Allows a bridge to batch-withdraw collateral for multiple received transactions after their cooldown periods.
	function withdrawReceivedBridgeValues(uint256[] memory transactionIds) internal {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		BridgeStorage.Layout storage bridgeLayout = BridgeStorage.layout();

		uint256 totalAmount = 0;
		for (uint256 i = transactionIds.length; i != 0; i--) {
			require(transactionIds[i - 1] <= bridgeLayout.lastId, "BridgeFacet: Invalid transactionId");
			BridgeTransaction storage bridgeTransaction = bridgeLayout.bridgeTransactions[transactionIds[i - 1]];
			require(bridgeTransaction.status == BridgeTransactionStatus.RECEIVED, "BridgeFacet: Already withdrawn");
			require(
				block.timestamp >= MAStorage.layout().withdrawCooldownPeriod + bridgeTransaction.timestamp,
				"BridgeFacet: Cooldown hasn't reached"
			);

			if (bridgeLayout.bridges[bridgeTransaction.bridge]) {
				require(bridgeTransaction.bridge == msg.sender, "BridgeFacet: Sender is not the transaction's bridge");
				totalAmount += bridgeTransaction.amount;
			} else {
				revert("BridgeFacet: Invalid bridge");
			}

			bridgeTransaction.status = BridgeTransactionStatus.WITHDRAWN;
		}

		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.withdrawLockedBalance -= totalAmount;
		LibSafeERC20.safeTransfer(appLayout.collateral, msg.sender, totalAmount);
	}

	/// @notice Suspends a received bridge transaction, preventing the bridge from withdrawing the funds.
	function suspendBridgeTransaction(uint256 transactionId) internal {
		BridgeStorage.Layout storage bridgeLayout = BridgeStorage.layout();
		BridgeTransaction storage bridgeTransaction = bridgeLayout.bridgeTransactions[transactionId];

		require(transactionId <= bridgeLayout.lastId, "BridgeFacet: Invalid transactionId");
		require(bridgeTransaction.status == BridgeTransactionStatus.RECEIVED, "BridgeFacet: Invalid status");
		bridgeTransaction.status = BridgeTransactionStatus.SUSPENDED;
	}

	/// @notice Restores a suspended bridge transaction to RECEIVED status with a reduced valid amount, crediting the invalid portion to the pool's internal balance.
	function restoreBridgeTransaction(uint256 transactionId, uint256 validAmount) internal {
		BridgeStorage.Layout storage bridgeLayout = BridgeStorage.layout();
		BridgeTransaction storage bridgeTransaction = bridgeLayout.bridgeTransactions[transactionId];
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		require(bridgeTransaction.status == BridgeTransactionStatus.SUSPENDED, "BridgeFacet: Invalid status");
		require(bridgeLayout.invalidBridgedAmountsPool != address(0), "BridgeFacet: Zero address");
		require(validAmount <= bridgeTransaction.amount, "BridgeFacet: High valid amount");

		AccountStorage.layout().balances[bridgeLayout.invalidBridgedAmountsPool] +=
			((bridgeTransaction.amount - validAmount) * (10 ** 18)) / (10 ** IERC20Metadata(appLayout.collateral).decimals());
		bridgeTransaction.status = BridgeTransactionStatus.RECEIVED;
		bridgeTransaction.amount = validAmount;
	}
}
