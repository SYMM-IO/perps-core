// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibAccount } from "../LibAccount.sol";
import { LibConnections } from "../LibConnections.sol";
import { LibHook } from "../LibHook.sol";
import { LibPartyBState } from "../extensions/LibPartyBState.sol";
import { LibQuote } from "../LibQuote.sol";
import { LibQuoteState } from "../extensions/LibQuoteState.sol";
import { LibQuoteFunding } from "../LibQuoteFunding.sol";
import { SharedEvents } from "../SharedEvents.sol";
import { LockedValuesOps } from "../LibLockedValues.sol";
import {
	AccountStorage,
	LiquidationDetail,
	LiquidationPartyBSymbolSnapshot,
	LiquidationSettlementState,
	LiquidationType,
	Price
} from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValues, Quote, QuoteStatus, QuoteStorage } from "../../storages/QuoteStorage.sol";

library LibPartyALiquidationProcess {
	using LockedValuesOps for LockedValues;
	using LibPartyBState for address;
	using LibQuoteState for Quote;

	event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);

	/// @notice Liquidates all pending (not yet opened) positions of Party A
	function liquidatePendingPositionsPartyA(address partyA) public returns (uint256[] memory liquidatedAmounts, bytes memory liquidationId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		// Validate liquidation state and prepare pending quote iteration.
		_requireActivePartyALiquidationAndRecordAction(maLayout, partyA);

		uint256 pendingCount = quoteLayout.partyAPendingQuotes[partyA].length;
		liquidatedAmounts = new uint256[](pendingCount);
		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;

		// Walk backwards because each iteration pops from partyAPendingQuotes.
		for (uint256 index = pendingCount; index > 0; index--) {
			uint256 actualIndex = index - 1;
			uint256 quoteId = quoteLayout.partyAPendingQuotes[partyA][actualIndex];
			Quote storage quote = quoteLayout.quotes[quoteId];
			// Clear PartyB-side pending quote buckets and pending locked balances once per PartyB/PartyA pair.
			if (
				(quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) &&
				quoteLayout.partyBPendingQuotes[quote.partyB][partyA].length > 0
			) {
				delete quoteLayout.partyBPendingQuotes[quote.partyB][partyA];
				LibConnections.removeConnectionIfNoPositions(partyA, quote.partyB);
				// Subtract from cross bucket before zeroing per-partyA balances
				accountLayout.partyBPendingLockedBalances[quote.partyB][address(0)].sub(
					accountLayout.partyBPendingLockedBalances[quote.partyB][partyA]
				);
				accountLayout.partyBPendingLockedBalances[quote.partyB][partyA].makeZero();
			}

			// Refund PartyA's reserved open fee into reimbursement, then mark the quote as liquidated.
			uint256 fee = LibQuote.getOpenTradingFee(quote.id);
			LibAccount.releaseReservedOpenTradingFee(partyA, fee);
			accountLayout.partyAReimbursement[partyA] += fee;
			emit SharedEvents.BalanceChangePartyA(partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);
			quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
			quote.statusModifyTimestamp = block.timestamp;
			liquidatedAmounts[actualIndex] = quote.quantity;
			quoteLayout.partyAPendingQuotes[partyA].pop();
			LibHook.callCancelQuoteHooks(quote.id, quote.partyA, quote.partyB, quote.affiliate);
		}

		// Clear PartyA-side aggregate pending locks after all pending quotes are consumed.
		accountLayout.pendingLockedBalances[partyA].makeZero();
	}

	/// @notice Liquidates open positions of Party A, settles PnL per Party B, and detects disputes
	function liquidatePositionsPartyA(
		address partyA,
		uint256[] memory quoteIds
	)
		public
		returns (
			bool,
			uint256[] memory liquidatedAmounts,
			uint256[] memory closeIds,
			uint256[] memory averageClosedPrices,
			bytes memory liquidationId
		)
	{
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Prepare return data and validate liquidation state.
		liquidatedAmounts = new uint256[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);
		averageClosedPrices = new uint256[](quoteIds.length);
		LiquidationDetail storage liquidationDetail = accountLayout.liquidationDetails[partyA];
		liquidationId = liquidationDetail.liquidationId;

		_requireActivePartyALiquidationAndRecordAction(maLayout, partyA);

		// Track PartyBs touched in this batch so connections can be cleaned once after positions close.
		address[] memory partyBsToCheck = new address[](quoteIds.length);
		uint256 uniquePartyBs = 0;

		for (uint256 index = 0; index < quoteIds.length; index++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[index]];

			// Validate quote state and block overlapping PartyB liquidation flows.
			quote.requireOpenPosition();
			quote.partyB.requireNotLiquidating(partyA);
			require(quote.partyA == partyA, "LiquidationFacet: Invalid party");

			// Mark the quote liquidated and compute its signed liquidation PnL.
			liquidatedAmounts[index] = quote.quantity - quote.closedAmount;
			closeIds[index] = quoteLayout.closeIds[quote.id];
			quote.quoteStatus = QuoteStatus.LIQUIDATED;
			quote.statusModifyTimestamp = block.timestamp;

			LibAccount.increasePartyBNonce(quote.partyB, partyA);
			(uint256 liquidationPrice, int256 accumulatedFundingFee) = _getLiquidationPriceAndFundingFee(accountLayout, partyA, quote);

			(bool hasMadeProfit, uint256 amount) = LibQuote.getValueOfQuoteForPartyA(liquidationPrice, LibQuote.quoteOpenAmount(quote), quote);

			LiquidationSettlementState storage settlementState = accountLayout.settlementStates[partyA][quote.partyB];
			int256 pnlWithFunding = (hasMadeProfit ? int256(amount) : -int256(amount)) - accumulatedFundingFee;

			// Open or update the pending settlement bucket for this PartyB.
			if (!settlementState.pending) {
				settlementState.pending = true;
				liquidationDetail.involvedPartyBCounts += 1;
			}
			// Remember the reserve contribution before this quote mutates actualAmount.
			int256 actualAmountBefore = settlementState.actualAmount;

			if (liquidationDetail.liquidationType == LiquidationType.NORMAL) {
				settlementState.cva += quote.lockedValues.cva;
				settlementState.actualAmount += pnlWithFunding;
				settlementState.expectedAmount += pnlWithFunding;
			} else if (liquidationDetail.liquidationType == LiquidationType.LATE) {
				// LF is exhausted in LATE liquidation, so `deficit` is the amount eaten from PartyA's total CVA.
				// returned quote CVA = quote CVA - quote's share of total CVA deficit
				settlementState.cva +=
					quote.lockedValues.cva - ((quote.lockedValues.cva * liquidationDetail.deficit) / accountLayout.lockedBalances[partyA].cva);
				settlementState.actualAmount += pnlWithFunding;
				settlementState.expectedAmount += pnlWithFunding;
			} else if (liquidationDetail.liquidationType == LiquidationType.OVERDUE) {
				if (pnlWithFunding >= 0) {
					settlementState.actualAmount += pnlWithFunding;
					settlementState.expectedAmount += pnlWithFunding;
				} else {
					uint256 lossAmount = uint256(-pnlWithFunding);
					// In OVERDUE, `deficit` is the residual loss after PartyA's allocation, LF, and CVA are exhausted.
					// adjusted quote loss = quote loss - quote's share of the residual unrealized loss deficit
					uint256 adjustedLoss = lossAmount - ((lossAmount * liquidationDetail.deficit) / uint256(-liquidationDetail.totalUnrealizedLoss));
					settlementState.actualAmount -= int256(adjustedLoss);
					settlementState.expectedAmount += pnlWithFunding;
				}
			}

			// Sync settlement reserve after the actualAmount update.
			// Reserve = sum of max(0, actualAmount) across pending settlements.
			// This prevents PartyB from deallocating funds owed to pending liquidation settlements.
			if (maLayout.crossModeEnabledForPartyB[quote.partyB]) {
				_syncPartyBLiquidationSettlementReserve(accountLayout, quote.partyB, actualAmountBefore, settlementState.actualAmount);
			}

			// Close the quote and update accumulated PartyA uPNL when this PartyB has no remaining positions.
			LibAccount.subFromPartyBLockedBalances(quote);
			LibQuote.closePositionFully(quote.id, liquidationPrice);

			if (quoteLayout.partyBPositionsCount[quote.partyB][partyA] == 0) {
				int256 partyAExpectedReceivableFromPartyB = accountLayout.settlementStates[partyA][quote.partyB].expectedAmount;
				address allocKey = LibAccount.partyBAllocationKey(quote.partyB, partyA);
				if (partyAExpectedReceivableFromPartyB < 0) {
					// Negative means PartyA lost against this PartyB; the loss can always be counted in full.
					liquidationDetail.partyAAccumulatedUpnl += partyAExpectedReceivableFromPartyB;
				} else {
					// Positive means PartyA gained against this PartyB; count only what PartyB's allocation can actually cover.
					if (accountLayout.partyBAllocatedBalances[quote.partyB][allocKey] >= uint256(partyAExpectedReceivableFromPartyB)) {
						liquidationDetail.partyAAccumulatedUpnl += partyAExpectedReceivableFromPartyB;
					} else {
						liquidationDetail.partyAAccumulatedUpnl += int256(accountLayout.partyBAllocatedBalances[quote.partyB][allocKey]);
					}
				}
			}

			LibHook.callClosePositionHooks(quote.id, liquidatedAmounts[index], liquidationPrice, quote.partyA, quote.partyB, quote.affiliate);
			averageClosedPrices[index] = quote.avgClosedPrice;

			// Record this PartyB for post-loop connection cleanup.
			bool found = false;
			for (uint256 j = 0; j < uniquePartyBs; j++) {
				if (partyBsToCheck[j] == quote.partyB) {
					found = true;
					break;
				}
			}
			if (!found) {
				partyBsToCheck[uniquePartyBs++] = quote.partyB;
			}

			emit SharedEvents.TradeVolumeRecorded(
				quote.id,
				(liquidatedAmounts[index] * liquidationPrice) / 1e18,
				quote.partyA,
				quote.partyB,
				quote.symbolId,
				quote.affiliate,
				SharedEvents.TradeVolumeType.LIQUIDATE
			);
		}

		// Remove PartyB connections whose pending/open exposure is now gone.
		for (uint256 i = 0; i < uniquePartyBs; i++) {
			LibConnections.removeConnectionIfNoPositions(partyA, partyBsToCheck[i]);
		}

		// If all positions are closed but signed PartyA uPNL does not match accumulated settlement, require dispute resolution.
		if (quoteLayout.partyAPositionsCount[partyA] == 0 && liquidationDetail.partyAAccumulatedUpnl != liquidationDetail.upnl) {
			liquidationDetail.disputed = true;
			return (true, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
		}
		return (false, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
	}

	/// @notice Resolves a liquidation dispute by overriding settlement amounts for Party Bs
	function resolveLiquidationDispute(
		address partyA,
		address[] memory partyBs,
		int256[] memory amounts,
		bool disputed
	) public returns (bytes memory) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		accountLayout.liquidationDetails[partyA].disputed = disputed;
		require(partyBs.length == amounts.length, "LiquidationFacet: Invalid length");

		// Override PartyB settlement buckets and keep cross-mode settlement reserves in sync.
		for (uint256 i = 0; i < partyBs.length; i++) {
			// Update settlement reserve for cross-mode PartyBs when dispute overrides actualAmount
			if (maLayout.crossModeEnabledForPartyB[partyBs[i]]) {
				int256 oldAmount = accountLayout.settlementStates[partyA][partyBs[i]].actualAmount;
				_syncPartyBLiquidationSettlementReserve(accountLayout, partyBs[i], oldAmount, amounts[i]);
			}
			accountLayout.settlementStates[partyA][partyBs[i]].actualAmount = amounts[i];
		}
		return accountLayout.liquidationDetails[partyA].liquidationId;
	}

	/// @notice Settles the liquidation by distributing funds between Party A and each Party B
	function settlePartyALiquidation(
		address partyA,
		address[] memory partyBs
	) public returns (int256[] memory settleAmounts, bytes memory liquidationId, bool fullySettled) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		// Validate active liquidation state and final settlement preconditions.
		_requireActivePartyALiquidationAndRecordAction(maLayout, partyA);
		require(
			quoteLayout.partyAPositionsCount[partyA] == 0 && quoteLayout.partyAPendingQuotes[partyA].length == 0,
			"LiquidationFacet: PartyA has still open positions"
		);
		require(!accountLayout.liquidationDetails[partyA].disputed, "LiquidationFacet: PartyA liquidation process get disputed");
		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;

		settleAmounts = new int256[](partyBs.length);
		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];

			// Settle one PartyB bucket and release its CVA.
			partyB.requireNotCrossLiquidating();
			LiquidationSettlementState storage settlementState = accountLayout.settlementStates[partyA][partyB];
			require(settlementState.pending, "LiquidationFacet: PartyB is not in settlement");
			settlementState.pending = false;
			accountLayout.liquidationDetails[partyA].involvedPartyBCounts -= 1;

			// Positive means PartyB owes PartyA; negative means PartyA owes PartyB.
			int256 partyAReceivableFromPartyB = settlementState.actualAmount;
			uint256 cva = settlementState.cva;

			// Use correct allocation key based on cross mode
			address allocKey = LibAccount.partyBAllocationKey(partyB, partyA);
			uint256 partyBAllocatedBalance = accountLayout.partyBAllocatedBalances[partyB][allocKey];

			partyBAllocatedBalance += cva;
			emit SharedEvents.BalanceChangePartyB(partyB, partyA, cva, SharedEvents.BalanceChangeType.CVA_IN);
			if (cva > 0) {
				emit SharedEvents.BalanceChangePartyA(partyA, cva, SharedEvents.BalanceChangeType.CVA_OUT);
			}

			// Apply PartyB realized PnL, or for isolated PartyB pay out whatever allocation remains.
			if (partyAReceivableFromPartyB < 0) {
				partyBAllocatedBalance += uint256(-partyAReceivableFromPartyB);
				emit SharedEvents.BalanceChangePartyB(
					partyB,
					partyA,
					uint256(-partyAReceivableFromPartyB),
					SharedEvents.BalanceChangeType.REALIZED_PNL_IN
				);
				settleAmounts[i] = partyAReceivableFromPartyB;
			} else {
				if (partyBAllocatedBalance >= uint256(partyAReceivableFromPartyB)) {
					// PartyB can fully pay PartyA
					partyBAllocatedBalance -= uint256(partyAReceivableFromPartyB);
					settleAmounts[i] = partyAReceivableFromPartyB;
					// Clear the non-negative settlement reserve contribution for cross-mode PartyBs.
					if (maLayout.crossModeEnabledForPartyB[partyB]) {
						accountLayout.partyBLiquidationSettlementReserve[partyB] -= uint256(partyAReceivableFromPartyB);
					}
				} else {
					// PartyB cannot fully pay PartyA
					// Cross-mode PartyBs must settle uPNL first via settlePartyBUpnlForLiquidation
					// to convert unrealized profit into allocated balance before settlement.
					// The clearing house takeover flow handles cases where settlement is not possible.
					require(!maLayout.crossModeEnabledForPartyB[partyB], "LiquidationFacet: Settle cross partyB uPNL first");
					settleAmounts[i] = int256(partyBAllocatedBalance);
					partyBAllocatedBalance = 0;
				}
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settleAmounts[i]), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			}
			accountLayout.partyBAllocatedBalances[partyB][allocKey] = partyBAllocatedBalance;

			delete accountLayout.settlementStates[partyA][partyB];
		}

		// Once every PartyB bucket is settled, release PartyA-side balances and close the liquidation.
		if (accountLayout.liquidationDetails[partyA].involvedPartyBCounts == 0) {
			_finalizePartyALiquidation(accountLayout, maLayout, partyA, liquidationId);
			fullySettled = true;
		}
	}

	function _finalizePartyALiquidation(
		AccountStorage.Layout storage accountLayout,
		MAStorage.Layout storage maLayout,
		address partyA,
		bytes memory liquidationId
	) private {
		uint256 deferredBalance = accountLayout.partyADeferredBalance[partyA];
		uint256 reimbursement = accountLayout.partyAReimbursement[partyA];

		// Route deferred excess and reimbursed pending fees based on liquidation severity.
		LiquidationType liqType = accountLayout.liquidationDetails[partyA].liquidationType;
		if (liqType == LiquidationType.LATE || liqType == LiquidationType.OVERDUE) {
			// `reimbursement` is the pending-credit bucket accumulated while PartyA is liquidating,
			// mainly released open-fee reserves from cancelled pending quotes and CH-routed credits.
			// In NORMAL liquidation PartyBs are made whole, so it returns to PartyA.
			// In LATE/OVERDUE, PartyBs may have CVA haircuts, so keep it in escrow for CH distribution.
			accountLayout.allocatedBalances[partyA] = deferredBalance;
			if (reimbursement > 0) {
				accountLayout.liquidationEscrow[partyA] += reimbursement;
				emit LiquidationEscrowCreated(partyA, liquidationId, reimbursement);
			}
		} else {
			// NORMAL: everything goes back to partyA
			accountLayout.allocatedBalances[partyA] = deferredBalance + reimbursement;
		}
		if (deferredBalance > 0) {
			emit SharedEvents.BalanceChangePartyA(partyA, deferredBalance, SharedEvents.BalanceChangeType.DEFERRED_BALANCE_IN);
		}
		accountLayout.partyADeferredBalance[partyA] = 0;
		accountLayout.partyAReimbursement[partyA] = 0;
		accountLayout.lockedBalances[partyA].makeZero();

		// Pay capped LF to the liquidation starter.
		uint256 lf = accountLayout.liquidationDetails[partyA].liquidationFee;
		if (lf > 0) {
			emit SharedEvents.BalanceChangePartyA(partyA, lf, SharedEvents.BalanceChangeType.LF_OUT);
			address liquidationStarter = accountLayout.liquidators[partyA][0];
			accountLayout.allocatedBalances[liquidationStarter] += lf;
			emit SharedEvents.BalanceChangePartyA(liquidationStarter, lf, SharedEvents.BalanceChangeType.LF_IN);
		}

		// Clear liquidation bookkeeping and bump nonce to invalidate old Muon payloads.
		delete accountLayout.liquidators[partyA];
		delete accountLayout.liquidationUsesPartyBSymbolSnapshots[partyA][liquidationId];
		delete accountLayout.liquidationDetails[partyA].liquidationType;
		maLayout.liquidationStatus[partyA] = false;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = 0;
		LibAccount.increasePartyANonce(partyA);
		LibHook.callLiquidationSettledHooks(partyA);
	}

	function _getLiquidationPriceAndFundingFee(
		AccountStorage.Layout storage accountLayout,
		address partyA,
		Quote storage quote
	) private view returns (uint256 liquidationPrice, int256 accumulatedFundingFee) {
		LiquidationDetail storage liquidationDetail = accountLayout.liquidationDetails[partyA];
		if (!accountLayout.liquidationUsesPartyBSymbolSnapshots[partyA][liquidationDetail.liquidationId]) {
			// Legacy flow uses per-symbol prices stored during the price setup step.
			Price storage price = accountLayout.symbolsPrices[partyA][quote.symbolId];
			require(price.timestamp == liquidationDetail.timestamp, "LiquidationFacet: Price should be set");
			return (price.price, LibQuoteFunding.getAccumulatedFundingFeeAt(quote.id, liquidationDetail.timestamp));
		}

		// Snapshot flow uses Muon-signed PartyB-symbol state captured at liquidation time.
		LiquidationPartyBSymbolSnapshot storage snapshot = accountLayout.liquidationPartyBSymbolSnapshots[partyA][liquidationDetail.liquidationId][
			quote.partyB
		][quote.symbolId];
		require(snapshot.isSet, "LiquidationFacet: Missing signed state");
		return (
			snapshot.price,
			LibQuoteFunding.getAccumulatedFundingFeeFromSnapshot(
				quote.id,
				snapshot.cumulativeLongFee,
				snapshot.cumulativeShortFee,
				liquidationDetail.timestamp
			)
		);
	}

	function _syncPartyBLiquidationSettlementReserve(
		AccountStorage.Layout storage accountLayout,
		address partyB,
		int256 oldActualAmount,
		int256 newActualAmount
	) private {
		uint256 oldContrib = oldActualAmount > 0 ? uint256(oldActualAmount) : 0;
		uint256 newContrib = newActualAmount > 0 ? uint256(newActualAmount) : 0;
		if (newContrib > oldContrib) {
			accountLayout.partyBLiquidationSettlementReserve[partyB] += (newContrib - oldContrib);
		} else if (oldContrib > newContrib) {
			accountLayout.partyBLiquidationSettlementReserve[partyB] -= (oldContrib - newContrib);
		}
	}

	function _requireActivePartyALiquidationAndRecordAction(MAStorage.Layout storage maLayout, address partyA) private {
		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
	}
}
