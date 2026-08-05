// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { SharedEvents } from "../SharedEvents.sol";
import { LibAccount } from "../LibAccount.sol";
import { LibSigner } from "../LibSigner.sol";
import { LockedValuesOps } from "../LibLockedValues.sol";
import { LibConnections } from "../LibConnections.sol";
import { LibHook } from "../LibHook.sol";

library LibPartyBLiquidation {
	using LockedValuesOps for LockedValues;

	/// @notice Starts PartyB liquidation.
	/// @param partyB The address of Party B.
	/// @param partyA The address of Party A.
	/// @param upnlPartyB The unrealized profit and loss of Party B.
	/// @param timestamp The timestamp of the liquidation.
	function startPartyBLiquidation(address partyB, address partyA, int256 upnlPartyB, uint256 timestamp) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Calculate available balance for liquidation
		int256 availableBalance = LibAccount.partyBAvailableBalanceForLiquidation(upnlPartyB, partyB, partyA);

		// Ensure Party B is insolvent
		require(availableBalance < 0, "LiquidationFacet: partyB is solvent");

		uint256 liquidatorShare;
		uint256 remainingLf;
		uint256 partyBAllocatedBalance = accountLayout.partyBAllocatedBalances[partyB][partyA];

		// Determine liquidator share and remaining locked funds
		if (uint256(-availableBalance) < accountLayout.partyBLockedBalances[partyB][partyA].lf) {
			remainingLf = accountLayout.partyBLockedBalances[partyB][partyA].lf - uint256(-availableBalance);
			// Locked LF can exceed what is actually allocated; without this cap the transfer below underflows
			// and PartyB liquidation cannot be started at all.
			if (remainingLf > partyBAllocatedBalance) remainingLf = partyBAllocatedBalance;
			liquidatorShare = (remainingLf * maLayout.liquidatorShare) / 1e18;

			maLayout.partyBPositionLiquidatorsShare[partyB][partyA] =
				(remainingLf - liquidatorShare) / quoteLayout.partyBPositionsCount[partyB][partyA];
		} else {
			maLayout.partyBPositionLiquidatorsShare[partyB][partyA] = 0;
		}

		// Update liquidation status and timestamp for Party B
		maLayout.partyBLiquidationStatus[partyB][partyA] = true;
		maLayout.partyBLiquidationTimestamp[partyB][partyA] = timestamp;

		uint256[] storage pendingQuotes = quoteLayout.partyAPendingQuotes[partyA];

		// Collect liquidated pending quoteIds for hook calls after state changes
		uint256[] memory liquidatedPendingIds = new uint256[](pendingQuotes.length);
		uint256 liquidatedCount = 0;

		for (uint256 index = 0; index < pendingQuotes.length; ) {
			Quote storage quote = quoteLayout.quotes[pendingQuotes[index]];

			if (quote.partyB == partyB && (quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING)) {
				liquidatedPendingIds[liquidatedCount++] = pendingQuotes[index];
				accountLayout.pendingLockedBalances[partyA].subQuote(quote);
				LibAccount.refundOpenTradingFee(quote.id, partyA);
				pendingQuotes[index] = pendingQuotes[pendingQuotes.length - 1];
				pendingQuotes.pop();
				quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
				quote.statusModifyTimestamp = block.timestamp;
			} else {
				index++;
			}
		}

		// Update allocated balances for Party A
		uint256 value = partyBAllocatedBalance - remainingLf;
		LibAccount.increasePartyAAllocatedBalance(partyA, value, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);

		// Clear pending quotes and reset balances for Party B
		delete quoteLayout.partyBPendingQuotes[partyB][partyA];
		LibConnections.removeConnectionIfNoPositions(partyA, partyB);
		LibAccount.decreasePartyBAllocatedBalance(partyB, partyA, value, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		LibAccount.decreasePartyBAllocatedBalance(partyB, partyA, remainingLf, SharedEvents.BalanceChangeType.LF_OUT);

		// Subtract from cross bucket before zeroing per-partyA balances
		LockedValues memory lv = accountLayout.partyBLockedBalances[partyB][partyA];
		LockedValues memory lvPending = accountLayout.partyBPendingLockedBalances[partyB][partyA];

		accountLayout.partyBLockedBalances[partyB][address(0)].sub(lv);
		accountLayout.partyBPendingLockedBalances[partyB][address(0)].sub(lvPending);

		accountLayout.partyBLockedBalances[partyB][partyA].makeZero();
		accountLayout.partyBPendingLockedBalances[partyB][partyA].makeZero();

		LibAccount.increasePartyANonce(partyA);

		// Fire cancel hooks after all state changes so core state is consistent when hooks run
		for (uint256 i = 0; i < liquidatedCount; i++) {
			Quote storage quote = quoteLayout.quotes[liquidatedPendingIds[i]];
			LibHook.callCancelQuoteHooks(liquidatedPendingIds[i], partyA, partyB, quote.affiliate);
		}

		// Transfer liquidator share to the liquidator
		if (liquidatorShare > 0) {
			LibAccount.increasePartyAAllocatedBalance(LibSigner.getSigner(), liquidatorShare, SharedEvents.BalanceChangeType.LF_IN);
		}
	}
}
