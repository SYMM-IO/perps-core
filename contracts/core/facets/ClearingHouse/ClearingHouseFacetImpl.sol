// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage, CrossLiquidationDetail, PartyATakeoverDetail } from "../../storages/ClearingHouseStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { FundingStorage } from "../../storages/FundingStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LibAggregateFunding } from "../../libraries/LibAggregateFunding.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteState } from "../../libraries/extensions/LibQuoteState.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";
import { LibPartyBState } from "../../libraries/extensions/LibPartyBState.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibHook } from "../../libraries/LibHook.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { IPartyALiquidationEvents } from "../../interfaces/IPartyALiquidationEvents.sol";

library ClearingHouseFacetImpl {
	using LockedValuesOps for LockedValues;
	using LibPartyBState for address;
	using LibQuoteState for Quote;

	/// @notice Types of clearing house liquidation flows
	enum LiquidationType {
		NONE,
		CROSS_PARTY_B,
		PARTY_A_TAKEOVER
	}

	/// @notice Returns the type of clearing house liquidation in progress for a subject
	function getLiquidationType(address subject) internal view returns (LiquidationType) {
		if (ClearingHouseStorage.layout().crossLiquidationDetails[subject].inProgress) {
			return LiquidationType.CROSS_PARTY_B;
		}
		if (ClearingHouseStorage.layout().partyATakeoverDetails[subject].inProgress) {
			return LiquidationType.PARTY_A_TAKEOVER;
		}
		return LiquidationType.NONE;
	}

	/// @notice Initiates clearing house liquidation for a cross-margin PartyB
	function liquidateCrossPartyB(address partyB, bytes memory liquidationId, int256 upnl, uint256 timestamp) public {
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(maLayout.crossModeEnabledForPartyB[partyB], "ClearingHouseFacet: partyB is not using cross mode");

		require(LibAccount.partyBAvailableBalanceForLiquidation(upnl, partyB, address(0)) < 0, "ClearingHouseFacet: partyB is solvent");
		maLayout.partyBLiquidationTimestamp[partyB][address(0)] = timestamp;
		chLayout.crossLiquidationDetails[partyB] = CrossLiquidationDetail({
			liquidationId: liquidationId,
			upnl: upnl,
			timestamp: timestamp,
			deallocatedPool: 0,
			inProgress: true
		});
	}

	/// @notice Takes over a stuck PartyA liquidation
	function takeoverPartyALiquidation(address partyA) public returns (bytes memory liquidationId) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();

		require(maLayout.liquidationStatus[partyA], "ClearingHouseFacet: PartyA is not being liquidated");
		require(!chLayout.partyATakeoverDetails[partyA].inProgress, "ClearingHouseFacet: Takeover already in progress");

		liquidationId = _executeTakeover(partyA);
	}

	/// @notice Clears all pending quotes between a partyB and partyA and zeroes out the associated locked balances.
	function _clearPartyBPendingQuotes(address partyB, address partyA) private {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (quoteLayout.partyBPendingQuotes[partyB][partyA].length > 0) {
			delete quoteLayout.partyBPendingQuotes[partyB][partyA];
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].sub(accountLayout.partyBPendingLockedBalances[partyB][partyA]);
			accountLayout.partyBPendingLockedBalances[partyB][partyA].makeZero();
		}
	}

	/// @notice Liquidates pending positions during clearing house liquidation
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover)
	/// @param counterparties For cross partyB: the partyAs to process. For partyA takeover: ignored (processes all pending)
	function liquidatePendingPositionsForClearingHouse(
		address subject,
		address[] memory counterparties
	) public returns (uint256[] memory liquidatedAmounts) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		LiquidationType liqType = getLiquidationType(subject);
		require(liqType != LiquidationType.NONE, "ClearingHouseFacet: No active liquidation");

		if (liqType == LiquidationType.CROSS_PARTY_B) {
			// Cross PartyB liquidation - process quotes where partyB matches subject
			address partyB = subject;
			for (uint256 j = 0; j < counterparties.length; j++) {
				address partyA = counterparties[j];
				_autoTakeoverPartyALiquidation(partyA);
				uint256[] storage pendingQuotes = quoteLayout.partyAPendingQuotes[partyA];

				// Collect cancelled quoteIds for hook calls after state changes
				uint256[] memory cancelledIds = new uint256[](pendingQuotes.length);
				uint256 cancelledCount = 0;

				for (uint256 i = 0; i < pendingQuotes.length;) {
					Quote storage quote = quoteLayout.quotes[pendingQuotes[i]];
					if (quote.partyB == partyB) {
						cancelledIds[cancelledCount++] = pendingQuotes[i];
						accountLayout.pendingLockedBalances[partyA].subQuote(quote);
						if (MAStorage.layout().liquidationStatus[partyA]) {
							uint256 fee = LibQuote.getReservedOpenTradingFee(quote, LibQuote.quoteOpenAmount(quote));
							LibAccount.releaseReservedOpenTradingFee(partyA, fee);
							LibAccount.increasePartyAReimbursement(partyA, fee, SharedEvents.ReimbursementChangeType.PLATFORM_FEE_IN);
						} else {
							LibAccount.refundOpenTradingFee(quote.id, partyA);
						}
						quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
						quote.statusModifyTimestamp = block.timestamp;
						pendingQuotes[i] = pendingQuotes[pendingQuotes.length - 1];
						pendingQuotes.pop();
					} else {
						i++;
					}
				}
				_clearPartyBPendingQuotes(partyB, partyA);
				LibConnections.removeConnectionIfNoPositions(partyA, partyB);

				// Fire hooks after state changes so core state is consistent when hooks run
				for (uint256 k = 0; k < cancelledCount; k++) {
					Quote storage quote = quoteLayout.quotes[cancelledIds[k]];
					LibHook.callCancelQuoteHooks(cancelledIds[k], partyA, partyB, quote.affiliate);
				}
			}
			liquidatedAmounts = new uint256[](0); // Not tracked for cross partyB
		} else {
			// PartyA takeover - process all of partyA's pending quotes
			address partyA = subject;
			uint256 pendingCount = quoteLayout.partyAPendingQuotes[partyA].length;
			liquidatedAmounts = new uint256[](pendingCount);
			uint256[] memory pendingQuoteIds = new uint256[](pendingCount);

			for (uint256 index = 0; index < pendingCount; index++) {
				uint256 quoteId = quoteLayout.partyAPendingQuotes[partyA][index];
				pendingQuoteIds[index] = quoteId;
				Quote storage quote = quoteLayout.quotes[quoteId];
				if (quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
					_clearPartyBPendingQuotes(quote.partyB, partyA);
					LibConnections.removeConnectionIfNoPositions(partyA, quote.partyB);
				}
				uint256 fee = LibQuote.getReservedOpenTradingFee(quote, LibQuote.quoteOpenAmount(quote));
				LibAccount.releaseReservedOpenTradingFee(partyA, fee);
				LibAccount.increasePartyAReimbursement(partyA, fee, SharedEvents.ReimbursementChangeType.PLATFORM_FEE_IN);
				quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
				quote.statusModifyTimestamp = block.timestamp;
				liquidatedAmounts[index] = quote.quantity;
			}
			accountLayout.pendingLockedBalances[partyA].makeZero();
			delete quoteLayout.partyAPendingQuotes[partyA];

			// Fire hooks after pending array is deleted so core state is consistent when hooks run
			for (uint256 i = 0; i < pendingQuoteIds.length; i++) {
				Quote storage quote = quoteLayout.quotes[pendingQuoteIds[i]];
				LibHook.callCancelQuoteHooks(pendingQuoteIds[i], partyA, quote.partyB, quote.affiliate);
			}
		}
	}

	/// @notice Liquidates open positions during clearing house liquidation
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover)
	/// @param quoteIds The quote IDs to liquidate
	/// @param prices The prices to use for liquidation
	function liquidatePositionsForClearingHouse(
		address subject,
		uint256[] memory quoteIds,
		uint256[] memory prices
	) public returns (uint256[] memory liquidatedAmounts, uint256[] memory closeIds) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		require(quoteIds.length == prices.length, "ClearingHouseFacet: Invalid length");

		LiquidationType liqType = getLiquidationType(subject);
		require(liqType != LiquidationType.NONE, "ClearingHouseFacet: No active liquidation");

		liquidatedAmounts = new uint256[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);

		// Track unique counterparties for connection cleanup
		address[] memory counterpartiesToCheck = new address[](quoteIds.length);
		uint256 uniqueCounterparties = 0;

		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
			address partyA = quote.partyA;
			address partyB = quote.partyB;

			quote.requireOpenPosition();

			// Validate the quote belongs to the subject
			if (liqType == LiquidationType.CROSS_PARTY_B) {
				require(partyB == subject, "ClearingHouseFacet: Invalid party");
				_autoTakeoverPartyALiquidation(partyA);
			} else {
				require(partyA == subject, "ClearingHouseFacet: Invalid party");
				partyB.requireNotLiquidating(partyA);
			}

			uint256 liquidationPrice = prices[i];
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);

			closeIds[i] = quoteLayout.closeIds[quote.id];
			quote.quoteStatus = QuoteStatus.LIQUIDATED;
			quote.statusModifyTimestamp = block.timestamp;

			accountLayout.lockedBalances[partyA].subQuote(quote);
			LibAccount.subFromPartyBLockedBalances(quote);

			if (FundingStorage.layout().fundingFees[quote.symbolId][partyB].epochDuration > 0) {
				// Sync funding state for aggregate accounting so subFromPartiesAggregateFunding
				// (called inside closePositionFully) uses an up-to-date accumulatedPaidFunding.
				// Balance transfers are intentionally skipped to keep liquidation non-reverting;
				// the clearing house operator must report the final accrued funding amount in
				// applyClearingHouseSettlement.
				int256 oldAccumulatedPaidFunding = quote.accumulatedPaidFunding;
				quote.lastFundingPaymentTimestamp = block.timestamp;
				LibQuoteFunding.updateAccumulatedPaidFunding(quote.id);
				LibAggregateFunding.updatePartiesAggregateFunding(quote, oldAccumulatedPaidFunding, openAmount);
			}

			uint256 closedAmount = LibQuote.closePositionFully(quote.id, liquidationPrice);
			liquidatedAmounts[i] = closedAmount;

			LibHook.callClosePositionHooks(quote.id, liquidatedAmounts[i], liquidationPrice, partyA, partyB, quote.affiliate);

			if (liqType == LiquidationType.CROSS_PARTY_B) {
				LibAccount.increaseBothUpnlCounters(partyB, partyA);
			} else {
				LibAccount.increasePartyBUpnlCounter(partyB, partyA);
			}

			// Emit TradeVolumeRecorded for both liquidation types
			emit SharedEvents.TradeVolumeRecorded(
				quote.id,
				(liquidatedAmounts[i] * liquidationPrice) / 1e18,
				partyA,
				partyB,
				quote.symbolId,
				quote.affiliate,
				SharedEvents.TradeVolumeType.LIQUIDATE
			);

			// Track unique counterparties for connection cleanup
			// For PARTY_A_TAKEOVER: track partyBs. For CROSS_PARTY_B: track partyAs.
			address counterparty = (liqType == LiquidationType.PARTY_A_TAKEOVER) ? partyB : partyA;
			bool found = false;
			for (uint256 j = 0; j < uniqueCounterparties; j++) {
				if (counterpartiesToCheck[j] == counterparty) {
					found = true;
					break;
				}
			}
			if (!found) {
				counterpartiesToCheck[uniqueCounterparties++] = counterparty;
			}
		}

		// Connection cleanup: remove connections for counterparties with no more positions
		for (uint256 i = 0; i < uniqueCounterparties; i++) {
			if (liqType == LiquidationType.PARTY_A_TAKEOVER) {
				// subject=partyA, counterparty=partyB
				LibConnections.removeConnectionIfNoPositions(subject, counterpartiesToCheck[i]);
			} else {
				// subject=partyB, counterparty=partyA
				LibConnections.removeConnectionIfNoPositions(counterpartiesToCheck[i], subject);
			}
		}

		return (liquidatedAmounts, closeIds);
	}

	/// @notice Closes positions for an affiliate wind-down using the normal close accounting path.
	/// @param affiliate The affiliate whose positions are being closed.
	/// @param quoteIds The quote IDs to close.
	/// @param prices The close prices to use.
	function closeAffiliatePositions(
		address affiliate,
		uint256[] memory quoteIds,
		uint256[] memory prices
	) public returns (uint256[] memory closedAmounts) {
		require(affiliate != address(0), "ClearingHouseFacet: Zero affiliate");
		require(quoteIds.length == prices.length, "ClearingHouseFacet: Invalid length");
		uint256 shutdownTime = GlobalAppStorage.layout().affiliateShutdownTime[affiliate];
		require(shutdownTime != 0, "ClearingHouseFacet: Affiliate shutdown not scheduled");
		require(block.timestamp >= shutdownTime, "ClearingHouseFacet: Affiliate shutdown date not reached");

		closedAmounts = new uint256[](quoteIds.length);

		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = QuoteStorage.layout().quotes[quoteIds[i]];
			LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
			address partyA = quote.partyA;
			address partyB = quote.partyB;
			require(quote.affiliate == affiliate, "ClearingHouseFacet: Invalid affiliate");
			quote.requireOpenPosition();
			require(!MAStorage.layout().liquidationStatus[partyA], "Accessibility: PartyA isn't solvent");
			partyB.requireNotLiquidating(partyA);

			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
			quote.requestedClosePrice = prices[i];
			quote.quantityToClose = openAmount;

			LibAccount.increaseBothUpnlCounters(partyB, partyA);
			LibQuoteClose.closeQuote(quoteIds[i], openAmount, prices[i]);
			closedAmounts[i] = openAmount;
		}
	}

	/// @notice Settles the clearing house liquidation for PartyA takeover
	/// @param partyA The partyA being settled
	/// @param settledPartyBs PartyBs whose settlement states should be cleaned up
	///        (includes partyBs processed by normal flow before takeover whose connections were already removed)
	function settlePartyATakeover(address partyA, address[] memory settledPartyBs) public returns (bytes memory liquidationId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();

		require(chLayout.partyATakeoverDetails[partyA].inProgress, "ClearingHouseFacet: Takeover not in progress");
		require(
			quoteLayout.partyAPositionsCount[partyA] == 0 && quoteLayout.partyAPendingQuotes[partyA].length == 0,
			"ClearingHouseFacet: PartyA has still open positions"
		);
		require(chLayout.partyATakeoverDetails[partyA].deallocatedPool == 0, "ClearingHouseFacet: Undistributed funds in deallocated pool");

		liquidationId = chLayout.partyATakeoverDetails[partyA].liquidationId;

		// Clear settlement states for partyBs explicitly provided by the clearing house.
		// This is needed because the normal liquidation flow may have set settlement states
		// for partyBs whose connections were already removed from connectedPartyBs.
		uint256 clearedSettlements = 0;
		for (uint256 i = 0; i < settledPartyBs.length; i++) {
			address partyB = settledPartyBs[i];
			bool pendingSettlement = accountLayout.settlementStates[partyA][partyB].pending;
			int256 rawFunding = accountLayout.partyALiquidationSettlementFundingFees[partyA][partyB];
			// Clear any settlement reserve contribution before deleting state.
			if (pendingSettlement) {
				LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, partyB, 0);
				clearedSettlements += 1;
				emit IPartyALiquidationEvents.LiquidationFundingSettlementAbandoned(partyA, partyB, rawFunding, liquidationId);
			}
			delete accountLayout.settlementStates[partyA][partyB];
			delete accountLayout.partyALiquidationSettlementFundingFees[partyA][partyB];
		}
		// Every pending settlement created by the normal liquidation flow must be cleared here.
		// Otherwise its settlement state and reserve contribution would be stranded once
		// liquidationDetails is deleted below, permanently locking the PartyB's reserved collateral.
		require(
			clearedSettlements == accountLayout.liquidationDetails[partyA].involvedPartyBCounts,
			"ClearingHouseFacet: Unsettled PartyB remaining"
		);

		// Release all escrowed balances back to partyA
		uint256 reimbursement = accountLayout.partyAReimbursement[partyA];
		uint256 deferredBalance = accountLayout.partyADeferredBalance[partyA];
		if (reimbursement + deferredBalance > 0) {
			accountLayout.partyADeferredBalance[partyA] = 0;
			if (deferredBalance > 0) {
				LibAccount.increasePartyAAllocatedBalance(partyA, deferredBalance, SharedEvents.BalanceChangeType.DEFERRED_BALANCE_IN);
			}
			if (reimbursement > 0) {
				LibAccount.decreasePartyAReimbursement(partyA, reimbursement, SharedEvents.ReimbursementChangeType.RELEASE_TO_ALLOCATED);
				LibAccount.increasePartyAAllocatedBalance(partyA, reimbursement, SharedEvents.BalanceChangeType.REIMBURSEMENT_IN);
			}
		}

		// Clear locked balances
		accountLayout.lockedBalances[partyA].makeZero();

		// Increment nonce
		LibAccount.increasePartyAUpnlCounter(partyA);

		// Clear liquidation status
		maLayout.liquidationStatus[partyA] = false;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = 0;

		// Delete liquidation details
		delete accountLayout.liquidationDetails[partyA];
		delete accountLayout.liquidationStartPositionCounts[partyA];

		// Delete takeover details
		delete chLayout.partyATakeoverDetails[partyA];
	}

	/// @notice Settles the clearing house liquidation for a cross partyB
	/// @dev Supports pagination: call with finalize=false to fire hooks for batches of settled partyAs,
	///      then call with finalize=true on the last batch to complete the settlement.
	/// @param partyB The cross partyB being settled
	/// @param settledPartyAs The partyAs whose liquidation hooks should be called in this batch
	/// @param finalize Whether to finalize the settlement (checks all positions closed and funds distributed)
	function settleCrossPartyBLiquidation(address partyB, address[] memory settledPartyAs, bool finalize) public {
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();
		CrossLiquidationDetail storage detail = chLayout.crossLiquidationDetails[partyB];

		require(detail.inProgress, "ClearingHouseFacet: Cross liquidation not in progress");

		if (finalize) {
			require(QuoteStorage.layout().partyBPositionsCount[partyB][address(0)] == 0, "ClearingHouseFacet: PartyB has still open positions");
			// NOTE: Using partyBPendingLockedBalances as a proxy for pending quotes; it can be zero even with pending quotes in edge cases.
			require(
				AccountStorage.layout().partyBPendingLockedBalances[partyB][address(0)].totalForPartyB() == 0,
				"ClearingHouseFacet: PartyB has pending quotes"
			);
			require(detail.deallocatedPool == 0, "ClearingHouseFacet: Undistributed funds in deallocated pool");

			detail.inProgress = false;
			detail.timestamp = 0;
		}

		// Fire hooks AFTER finalize clears inProgress, so bound VAs can be deleted
		// For non-finalize calls, hooks still fire but bound VAs will be deferred (expected behavior)
		for (uint256 i = 0; i < settledPartyAs.length; i++) {
			LibHook.callLiquidationSettledHooks(settledPartyAs[i]);
		}
	}

	event AutoTakeoverPartyALiquidation(address indexed partyA, bytes liquidationId);

	/// @notice Executes the takeover of a PartyA liquidation by clearing disputed state and creating takeover details.
	/// @dev Clears disputed flag, liquidation fee, liquidators, and sets takeover state.
	function _executeTakeover(address partyA) private returns (bytes memory liquidationId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();

		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;

		accountLayout.liquidationDetails[partyA].disputed = false;
		accountLayout.liquidationDetails[partyA].liquidationFee = 0;
		delete accountLayout.liquidators[partyA];

		chLayout.partyATakeoverDetails[partyA] = PartyATakeoverDetail({ liquidationId: liquidationId, deallocatedPool: 0, inProgress: true });
	}

	/// @notice Automatically takes over a partyA liquidation during cross partyB processing.
	/// @dev Safe to call multiple times; only the first call has effect.
	function _autoTakeoverPartyALiquidation(address partyA) private returns (bool) {
		if (!MAStorage.layout().liquidationStatus[partyA]) return false;
		if (ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress) return false;

		bytes memory liquidationId = _executeTakeover(partyA);
		emit AutoTakeoverPartyALiquidation(partyA, liquidationId);
		return true;
	}

	/// @notice Applies a soft liquidation penalty to a Party B by deducting from their allocated and/or deposit balances.
	function softPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance) public {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();

		uint256 totalPenalty = penaltyFromAllocated + penaltyFromBalance;
		if (totalPenalty != 0) {
			require(globalLayout.softLiquidationPenaltyCollector != address(0), "ClearingHouse: No Penalty Collector");

			if (penaltyFromAllocated != 0) {
				require(
					penaltyFromAllocated <= accountLayout.partyBAllocatedBalances[partyB][partyA],
					"ClearingHouse: Insufficient Allocated Balance"
				);
				LibAccount.decreasePartyBAllocatedBalance(partyB, partyA, penaltyFromAllocated, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			}

			if (penaltyFromBalance != 0) {
				require(penaltyFromBalance <= accountLayout.balances[partyB], "ClearingHouse: Insufficient Balance");
				accountLayout.balances[partyB] -= penaltyFromBalance;
			}

			accountLayout.balances[globalLayout.softLiquidationPenaltyCollector] += totalPenalty;
		}
	}

	/// @notice Distributes pending fees from the liquidation escrow to receivers
	/// @dev Called by clearing house after a LATE/OVERDUE PartyA liquidation settlement.
	///      Supports both partyA-style addresses (allocatedBalances) and partyBs (partyBAllocatedBalances).
	/// @param partyA The partyA whose liquidation escrow to distribute from
	/// @param receivers The addresses to distribute to
	/// @param allocationKeys The allocation keys for each receiver (used for partyB receivers)
	/// @param amounts The amounts to distribute
	function distributeFromLiquidationEscrow(
		address partyA,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) public {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		require(receivers.length == allocationKeys.length && receivers.length == amounts.length, "ClearingHouseFacet: Invalid length");

		uint256 totalDistributed = 0;
		for (uint256 i = 0; i < receivers.length; i++) {
			if (amounts[i] == 0) continue;
			if (maLayout.partyBStatus[receivers[i]]) {
				LibAccount.increasePartyBAllocatedBalance(
					receivers[i],
					allocationKeys[i],
					amounts[i],
					SharedEvents.BalanceChangeType.REALIZED_PNL_IN
				);
			} else {
				LibAccount.increasePartyAAllocatedBalance(receivers[i], amounts[i], SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			}
			totalDistributed += amounts[i];
		}
		require(accountLayout.liquidationEscrow[partyA] >= totalDistributed, "ClearingHouseFacet: Insufficient pool balance");
		accountLayout.liquidationEscrow[partyA] -= totalDistributed;
	}
}
