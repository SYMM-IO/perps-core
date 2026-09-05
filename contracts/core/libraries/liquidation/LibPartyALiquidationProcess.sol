// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import { LibAccount } from "../LibAccount.sol";
import { LibConnections } from "../LibConnections.sol";
import { LibHook } from "../LibHook.sol";
import { LibPartyBState } from "../extensions/LibPartyBState.sol";
import { LibQuote } from "../LibQuote.sol";
import { LibQuoteState } from "../extensions/LibQuoteState.sol";
import { LibQuoteFunding } from "../LibQuoteFunding.sol";
import { LibUtils } from "../LibUtils.sol";
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
import { IPartyALiquidationEvents } from "../../interfaces/IPartyALiquidationEvents.sol";

library LibPartyALiquidationProcess {
	using LockedValuesOps for LockedValues;
	using LibPartyBState for address;
	using LibQuoteState for Quote;

	event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);

	/// @dev Raw accounting units by which the signed aggregate PartyA uPNL may differ from the per-quote settlement total,
	///      per open position at liquidation start. Each quote truncates its price PnL once and its funding once, while
	///      the aggregate truncates the group's price PnL once and its funding once per quote plus once per group. Every
	///      truncation error is below one unit, so the integer difference is at most three units per position.
	uint256 internal constant UPNL_ROUNDING_ALLOWANCE_PER_POSITION = 3;

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
			uint256 fee = LibQuote.getReservedOpenTradingFee(quote, LibQuote.quoteOpenAmount(quote));
			LibAccount.releaseReservedOpenTradingFee(partyA, fee);
			LibAccount.increasePartyAReimbursement(partyA, fee, SharedEvents.ReimbursementChangeType.PLATFORM_FEE_IN);
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

			LibAccount.increasePartyBUpnlCounter(quote.partyB, partyA);
			(uint256 liquidationPrice, int256 accumulatedFundingFee) = _getLiquidationPriceAndFundingFee(accountLayout, partyA, quote);

			(bool hasMadeProfit, uint256 amount) = LibQuote.getValueOfQuoteForPartyA(liquidationPrice, LibQuote.quoteOpenAmount(quote), quote);

			LiquidationSettlementState storage settlementState = accountLayout.settlementStates[partyA][quote.partyB];
			int256 partyAPnl = hasMadeProfit ? int256(amount) : -int256(amount);
			int256 partyBPnl = -partyAPnl;
			int256 pnlWithFunding = partyAPnl - accumulatedFundingFee;
			accountLayout.partyALiquidationSettlementFundingFees[partyA][quote.partyB] += accumulatedFundingFee;
			emit IPartyALiquidationEvents.QuoteLiquidationFundingCalculated(
				partyA,
				quote.partyB,
				quote.id,
				quote.symbolId,
				accumulatedFundingFee,
				partyBPnl,
				liquidationId
			);

			// Open or update the pending settlement bucket for this PartyB.
			if (!settlementState.pending) {
				settlementState.pending = true;
				liquidationDetail.involvedPartyBCounts += 1;
			}
			if (liquidationDetail.liquidationType == LiquidationType.NORMAL) {
				settlementState.cva += quote.lockedValues.cva;
				settlementState.actualAmount += pnlWithFunding;
				settlementState.expectedAmount += pnlWithFunding;
			} else if (liquidationDetail.liquidationType == LiquidationType.LATE) {
				// LF is exhausted in LATE liquidation, so `deficit` is the amount eaten from PartyA's total CVA.
				// returned quote CVA = quote CVA - quote's share of total CVA deficit
				if (liquidationDetail.deficit == 0) {
					settlementState.cva += quote.lockedValues.cva;
				} else {
					settlementState.cva +=
						quote.lockedValues.cva - ((quote.lockedValues.cva * liquidationDetail.deficit) / accountLayout.lockedBalances[partyA].cva);
				}
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

			// Track the settlement reserve for all modes; LibAccount applies it only in cross mode.
			LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, quote.partyB, settlementState.actualAmount);

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

		// Once all positions are closed, the accumulated per-quote settlement must match the signed PartyA uPNL up to the
		// rounding allowance; anything beyond that requires dispute resolution.
		if (quoteLayout.partyAPositionsCount[partyA] == 0) {
			int256 signedUpnl = liquidationDetail.upnl;
			int256 settledUpnl = liquidationDetail.partyAAccumulatedUpnl;
			uint256 difference = LibUtils.absDiff(settledUpnl, signedUpnl);
			if (difference != 0) {
				uint256 allowance = UPNL_ROUNDING_ALLOWANCE_PER_POSITION * accountLayout.liquidationStartPositionCounts[partyA];
				if (difference > allowance) {
					liquidationDetail.disputed = true;
					return (true, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
				}
				emit IPartyALiquidationEvents.LiquidationUpnlRoundingAccepted(partyA, signedUpnl, settledUpnl, allowance, liquidationId);
			}
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

		// Override PartyB settlement buckets and keep settlement reserves in sync.
		for (uint256 i = 0; i < partyBs.length; i++) {
			accountLayout.settlementStates[partyA][partyBs[i]].actualAmount = amounts[i];
			LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, partyBs[i], amounts[i]);
		}
		return accountLayout.liquidationDetails[partyA].liquidationId;
	}

	/// @notice Settles the liquidation by distributing funds between Party A and each Party B
	function settlePartyALiquidation(
		address partyA,
		address[] memory partyBs
	)
		public
		returns (
			int256[] memory settleAmounts,
			address[] memory allocationKeys,
			uint256[] memory cvaAmounts,
			bytes memory liquidationId,
			bool fullySettled
		)
	{
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
		allocationKeys = new address[](partyBs.length);
		cvaAmounts = new uint256[](partyBs.length);
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
			int256 fundingFee = accountLayout.partyALiquidationSettlementFundingFees[partyA][partyB];
			uint256 cva = settlementState.cva;
			cvaAmounts[i] = cva;

			// Use correct allocation key based on cross mode
			address allocKey = LibAccount.partyBAllocationKey(partyB, partyA);
			allocationKeys[i] = allocKey;
			uint256 partyBAllocatedBalance = LibAccount.increasePartyBAllocatedBalance(partyB, allocKey, cva, SharedEvents.BalanceChangeType.CVA_IN);

			// Determine the settled amount first; the allocation bucket is mutated below so the
			// funding and realized-PnL components can each carry their own balance-change type.
			if (partyAReceivableFromPartyB < 0) {
				settleAmounts[i] = partyAReceivableFromPartyB;
			} else {
				if (partyBAllocatedBalance >= uint256(partyAReceivableFromPartyB)) {
					// PartyB can fully pay PartyA
					settleAmounts[i] = partyAReceivableFromPartyB;
				} else {
					// PartyB cannot fully pay PartyA
					// Cross-mode PartyBs must settle uPNL first via settlePartyBUpnlForLiquidation
					// to convert unrealized profit into allocated balance before settlement.
					// The clearing house takeover flow handles cases where settlement is not possible.
					require(!maLayout.crossModeEnabledForPartyB[partyB], "LiquidationFacet: Settle cross partyB uPNL first");
					settleAmounts[i] = int256(partyBAllocatedBalance);
				}
			}
			int256 rawFundingFee = fundingFee;
			(uint256 scaleNumerator, uint256 scaleDenominator) = _getFundingSettlementScale(settlementState.expectedAmount, settleAmounts[i]);
			fundingFee = _scaleFundingFee(fundingFee, scaleNumerator, scaleDenominator);
			int256 rawPnl = -(settlementState.expectedAmount + rawFundingFee);
			int256 settledPnl = -(settleAmounts[i] + fundingFee);
			_applyPartyBSettlementBalanceChanges(partyB, allocKey, fundingFee, settledPnl);
			emit IPartyALiquidationEvents.LiquidationFundingSettled(
				partyA,
				partyB,
				allocKey,
				rawFundingFee,
				fundingFee,
				rawPnl,
				settledPnl,
				scaleNumerator,
				scaleDenominator,
				liquidationId
			);

			LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, partyB, 0);
			delete accountLayout.settlementStates[partyA][partyB];
			delete accountLayout.partyALiquidationSettlementFundingFees[partyA][partyB];
		}

		// Once every PartyB bucket is settled, release PartyA-side balances and close the liquidation.
		if (accountLayout.liquidationDetails[partyA].involvedPartyBCounts == 0) {
			_finalizePartyALiquidation(accountLayout, maLayout, partyA, liquidationId);
			fullySettled = true;
		}
	}

	/// @dev Returns the exact factor used when a haircut, dispute override, or isolated payout cap
	///      reduces the final settlement. Direction-changing or zero overrides classify funding as zero.
	function _getFundingSettlementScale(int256 expectedAmount, int256 settledAmount) private pure returns (uint256 numerator, uint256 denominator) {
		if (expectedAmount == settledAmount) return (1, 1);
		if (expectedAmount == 0 || settledAmount == 0 || (expectedAmount > 0) != (settledAmount > 0)) return (0, 1);

		uint256 expectedAbs = SignedMath.abs(expectedAmount);
		uint256 settledAbs = SignedMath.abs(settledAmount);
		if (settledAbs >= expectedAbs) return (1, 1);
		return (settledAbs, expectedAbs);
	}

	function _scaleFundingFee(int256 fundingFee, uint256 numerator, uint256 denominator) private pure returns (int256) {
		if (fundingFee == 0 || numerator == 0) return 0;
		uint256 scaledFundingAbs = Math.mulDiv(SignedMath.abs(fundingFee), numerator, denominator);
		return fundingFee > 0 ? int256(scaledFundingAbs) : -int256(scaledFundingAbs);
	}

	/// @dev Applies the final net PartyB settlement to its allocation bucket, split into funding and
	///      realized-PnL classifications so each carries its own balance-change type. Both amounts
	///      are signed from PartyB's perspective: positive means PartyB receives, negative means PartyB pays.
	/// @dev Credits are applied before debits so a mixed-direction split never drives the bucket
	///      temporarily negative.
	function _applyPartyBSettlementBalanceChanges(address partyB, address allocationKey, int256 fundingFee, int256 settledPnl) private {
		if (fundingFee > 0) {
			LibAccount.increasePartyBAllocatedBalance(partyB, allocationKey, uint256(fundingFee), SharedEvents.BalanceChangeType.FUNDING_FEE_IN);
		}
		if (settledPnl > 0) {
			LibAccount.increasePartyBAllocatedBalance(partyB, allocationKey, uint256(settledPnl), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		}
		if (fundingFee < 0) {
			LibAccount.decreasePartyBAllocatedBalance(partyB, allocationKey, uint256(-fundingFee), SharedEvents.BalanceChangeType.FUNDING_FEE_OUT);
		}
		if (settledPnl < 0) {
			LibAccount.decreasePartyBAllocatedBalance(partyB, allocationKey, uint256(-settledPnl), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
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
		uint256 previousAllocatedBalance = accountLayout.allocatedBalances[partyA];

		// Route deferred excess and reimbursed pending fees based on liquidation severity.
		LiquidationType liqType = accountLayout.liquidationDetails[partyA].liquidationType;
		if (liqType == LiquidationType.LATE || liqType == LiquidationType.OVERDUE) {
			// `reimbursement` is the pending-credit bucket accumulated while PartyA is liquidating,
			// mainly released open-fee reserves from cancelled pending quotes and CH-routed credits.
			// In NORMAL liquidation PartyBs are made whole, so it returns to PartyA.
			// In LATE/OVERDUE, PartyBs may have CVA haircuts, so keep it in escrow for CH distribution.
			if (reimbursement > 0) {
				accountLayout.liquidationEscrow[partyA] += reimbursement;
				emit LiquidationEscrowCreated(partyA, liquidationId, reimbursement);
				LibAccount.decreasePartyAReimbursement(partyA, reimbursement, SharedEvents.ReimbursementChangeType.MOVE_TO_LIQUIDATION_ESCROW);
			}
		}

		// Finalization replaces the liquidated account's old allocation with the balances that
		// survive liquidation. Emit a complete debit/credit breakdown whose net exactly matches
		// that replacement; earlier reimbursement and locked-balance movements are not allocations.
		uint256 lf = accountLayout.liquidationDetails[partyA].liquidationFee;
		uint256 lfFromAllocated = lf < previousAllocatedBalance ? lf : previousAllocatedBalance;
		if (lfFromAllocated > 0) {
			LibAccount.decreasePartyAAllocatedBalance(partyA, lfFromAllocated, SharedEvents.BalanceChangeType.LF_OUT);
		}
		uint256 realizedDebit = previousAllocatedBalance - lfFromAllocated;
		if (realizedDebit > 0) {
			LibAccount.decreasePartyAAllocatedBalance(partyA, realizedDebit, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		}
		if (deferredBalance > 0) {
			LibAccount.increasePartyAAllocatedBalance(partyA, deferredBalance, SharedEvents.BalanceChangeType.DEFERRED_BALANCE_IN);
		}
		if (liqType == LiquidationType.NORMAL && reimbursement > 0) {
			LibAccount.decreasePartyAReimbursement(partyA, reimbursement, SharedEvents.ReimbursementChangeType.RELEASE_TO_ALLOCATED);
			LibAccount.increasePartyAAllocatedBalance(partyA, reimbursement, SharedEvents.BalanceChangeType.REIMBURSEMENT_IN);
		}
		accountLayout.partyADeferredBalance[partyA] = 0;
		accountLayout.lockedBalances[partyA].makeZero();

		// Pay capped LF to the liquidation starter.
		if (lf > 0) {
			address liquidationStarter = accountLayout.liquidators[partyA][0];
			LibAccount.increasePartyAAllocatedBalance(liquidationStarter, lf, SharedEvents.BalanceChangeType.LF_IN);
		}

		// Clear liquidation bookkeeping and bump nonce to invalidate old Muon payloads.
		delete accountLayout.liquidators[partyA];
		delete accountLayout.liquidationUsesPartyBSymbolSnapshots[partyA][liquidationId];
		delete accountLayout.liquidationStartPositionCounts[partyA];
		delete accountLayout.liquidationDetails[partyA].liquidationType;
		maLayout.liquidationStatus[partyA] = false;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = 0;
		LibAccount.increasePartyAUpnlCounter(partyA);
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
			return (price.price, LibQuoteFunding.getAccumulatedFundingFee(quote.id));
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
				liquidationDetail.liquidationTimestamp
			)
		);
	}

	function _requireActivePartyALiquidationAndRecordAction(MAStorage.Layout storage maLayout, address partyA) private {
		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
	}
}
