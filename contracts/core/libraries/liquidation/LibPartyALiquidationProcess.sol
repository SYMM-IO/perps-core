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
import { LibSymbolAdjustment } from "../LibSymbolAdjustment.sol";
import { LibUtils } from "../LibUtils.sol";
import { LibPartyALiquidationShared } from "./LibPartyALiquidationShared.sol";
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

	/// @notice Liquidates open positions of Party A, settles PnL per Party B, and detects disputes.
	/// @dev During restatement, stored venue-basis liquidation prices are converted independently for each quote so mixed
	///      old- and new-basis positions settle against their own storage basis.
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
		require(quoteIds.length > 0, "LiquidationFacet: Empty quote list");

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

			// Open or update the pending settlement bucket for this PartyB. Buckets hold raw amounts only: the CVA to
			// return and the share of any uncovered loss are fixed once, from on-chain totals, when the last position closes.
			if (!settlementState.pending) {
				settlementState.pending = true;
				liquidationDetail.involvedPartyBCounts += 1;
				accountLayout.partyALiquidationPartyBs[partyA].push(quote.partyB);
			}
			if (liquidationDetail.liquidationType != LiquidationType.OVERDUE) {
				settlementState.cva += quote.lockedValues.cva;
			}
			settlementState.actualAmount += pnlWithFunding;
			settlementState.expectedAmount += pnlWithFunding;

			// Close the quote and update accumulated PartyA uPNL when this PartyB has no remaining positions.
			LibAccount.subFromPartyBLockedBalances(quote);
			LibQuote.closePositionFully(quote.id, liquidationPrice);
			LibConnections.removeConnectionIfNoPositions(partyA, quote.partyB);

			if (quoteLayout.partyBPositionsCount[quote.partyB][partyA] == 0) {
				_countClosedBucket(accountLayout, liquidationDetail, settlementState, partyA, quote.partyB);
			}

			// Track the settlement reserve for all modes; LibAccount applies it only in cross mode.
			LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, quote.partyB, settlementState.actualAmount);

			LibHook.callClosePositionHooks(quote.id, liquidatedAmounts[index], liquidationPrice, quote.partyA, quote.partyB, quote.affiliate);
			averageClosedPrices[index] = quote.avgClosedPrice;

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

		// The close that ends the position list checks the signed uPNL and fixes the settlement plan.
		if (quoteLayout.partyAPositionsCount[partyA] == 0) {
			return (_planSettlement(accountLayout, partyA, liquidationDetail), liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
		}
		return (false, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
	}

	/// @dev Counts a PartyB's closed bucket into PartyA's accumulated uPNL. A loss is counted in full. A gain is counted
	///      only up to what the PartyB's allocation can actually cover, and the bucket is planned at that counted amount,
	///      so a payer never pays more than was checked here. The allocation cannot fall again before settlement.
	function _countClosedBucket(
		AccountStorage.Layout storage accountLayout,
		LiquidationDetail storage liquidationDetail,
		LiquidationSettlementState storage settlementState,
		address partyA,
		address partyB
	) private {
		int256 expectedAmount = settlementState.expectedAmount;
		if (expectedAmount < 0) {
			liquidationDetail.partyAAccumulatedUpnl += expectedAmount;
			return;
		}
		uint256 allocation = accountLayout.partyBAllocatedBalances[partyB][LibAccount.partyBAllocationKey(partyB, partyA)];
		int256 counted = allocation >= uint256(expectedAmount) ? expectedAmount : int256(allocation);
		liquidationDetail.partyAAccumulatedUpnl += counted;
		settlementState.actualAmount = counted;
	}

	/// @dev Runs once, in the close that brings PartyA's position count to zero. The signed uPNL is checked against the
	///      on-chain total with three raw rounding units per position captured at start (the bound assumes repaired
	///      funding aggregates and exact aggregate notional in the oracle); a larger difference disputes. An accepted
	///      difference settles at whichever total is closer to zero, or at zero when one is a profit and the other a
	///      loss, and the buckets are trimmed to match now. Every bucket then receives its final amounts from on-chain
	///      totals. For an undisputed plan, what the buckets pay out plus the final liquidator fee, the net vault credit
	///      and the change in PartyA's deferred balance during planning equals PartyA's allocation.
	function _planSettlement(
		AccountStorage.Layout storage accountLayout,
		address partyA,
		LiquidationDetail storage detail
	) private returns (bool disputed) {
		int256 signedUpnl = detail.upnl;
		int256 netUpnl = detail.partyAAccumulatedUpnl;
		uint256 difference = LibUtils.absDiff(netUpnl, signedUpnl);
		if (
			difference >
			LibPartyALiquidationShared.LIQUIDATION_UPNL_ROUNDING_ALLOWANCE_PER_POSITION * accountLayout.liquidationStartPositionCounts[partyA]
		) {
			// The signed figure stays the basis of the plan; a resolver overrides the buckets it disagrees with.
			detail.disputed = true;
			disputed = true;
			netUpnl = signedUpnl;
		} else if (difference != 0) {
			netUpnl = _applyRoundingCap(accountLayout, partyA, signedUpnl, netUpnl);
		}

		if (detail.liquidationType == LiquidationType.NORMAL) {
			if (!disputed && !_settleRoundingDifference(accountLayout, partyA, detail, netUpnl - signedUpnl)) {
				detail.disputed = true;
				disputed = true;
			}
		} else {
			_distributeLateAndOverdue(accountLayout, partyA, int256(accountLayout.allocatedBalances[partyA]) + netUpnl);
		}
	}

	/// @dev Settles at whichever of the signed and on-chain uPNL is closer to zero (zero when they disagree on direction).
	///      The gap comes off buckets on the on-chain total's side, in first-close order, each down to zero at most, so
	///      the stored plan is final once the last position closes.
	function _applyRoundingCap(
		AccountStorage.Layout storage accountLayout,
		address partyA,
		int256 signedUpnl,
		int256 settledUpnl
	) private returns (int256 cappedUpnl) {
		cappedUpnl = _smallerSameDirectionUpnl(signedUpnl, settledUpnl);
		int256 remainingReduction = settledUpnl - cappedUpnl;
		address[] storage partyBs = accountLayout.partyALiquidationPartyBs[partyA];
		for (uint256 i = 0; i < partyBs.length && remainingReduction != 0; i++) {
			LiquidationSettlementState storage state = accountLayout.settlementStates[partyA][partyBs[i]];
			int256 remainingAfter = _capSettlementToSmallerUpnl(state, remainingReduction);
			if (remainingAfter != remainingReduction) {
				LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, partyBs[i], state.actualAmount);
			}
			remainingReduction = remainingAfter;
		}
		require(remainingReduction == 0, "LiquidationFacet: Invalid rounding cap");
		accountLayout.liquidationDetails[partyA].partyAAccumulatedUpnl = cappedUpnl;
	}

	/// @dev NORMAL only. The liquidator fee and vault credit were sized at start from the signed uPNL, while the buckets
	///      settle at the capped on-chain amount. A positive difference is collateral the buckets do not need: it is set
	///      aside with PartyA's deferred balance instead of being stranded in the diamond. A negative one is paid by
	///      PartyA's deferred balance, then the liquidator fee, then the insurance vault's available balance (not only this
	///      liquidation's credit); the allocation finalization consumes then covers the buckets exactly. Returns false only
	///      if those three cannot cover it.
	function _settleRoundingDifference(
		AccountStorage.Layout storage accountLayout,
		address partyA,
		LiquidationDetail storage detail,
		int256 difference
	) private returns (bool) {
		if (difference >= 0) {
			_setAsideForPartyA(accountLayout, partyA, uint256(difference));
			return true;
		}
		uint256 shortfall = uint256(-difference);
		uint256 take = Math.min(accountLayout.partyADeferredBalance[partyA], shortfall);
		accountLayout.partyADeferredBalance[partyA] -= take;
		shortfall -= take;
		take = Math.min(detail.liquidationFee, shortfall);
		detail.liquidationFee -= take;
		shortfall -= take;
		if (shortfall > 0) {
			address vault = MAStorage.layout().liquidationInsuranceVault;
			take = Math.min(accountLayout.balances[vault], shortfall);
			accountLayout.balances[vault] -= take;
			shortfall -= take;
		}
		return shortfall == 0;
	}

	/// @dev Moves collateral the settlement will not need out of the allocation finalization consumes and into
	///      PartyA's deferred balance, which finalization returns to PartyA. Same movement as a late allocation at start.
	function _setAsideForPartyA(AccountStorage.Layout storage accountLayout, address partyA, uint256 amount) private {
		if (amount == 0) return;
		LibAccount.decreasePartyAAllocatedBalance(partyA, amount, SharedEvents.BalanceChangeType.DEFERRED_BALANCE_OUT);
		accountLayout.partyADeferredBalance[partyA] += amount;
	}

	/// @dev LATE and OVERDUE. `resources` is PartyA's allocation plus its net uPNL, the collateral left once every
	///      bucket is settled at its planned amount. A positive amount is returned as CVA pro rata to each bucket's
	///      locked CVA; anything beyond the total CVA joins PartyA's deferred balance. A negative amount is the loss no
	///      collateral covers: it is shared pro rata across the buckets PartyA owes (their net claims), and no CVA is
	///      returned. Both use a running remainder, so the amounts are exact to the unit. Buckets PartyA collects from
	///      keep the amount counted when they closed.
	function _distributeLateAndOverdue(AccountStorage.Layout storage accountLayout, address partyA, int256 resources) private {
		address[] storage partyBs = accountLayout.partyALiquidationPartyBs[partyA];
		uint256 count = partyBs.length;
		uint256 remainingCva;
		uint256 remainingClaims;
		for (uint256 i = 0; i < count; i++) {
			LiquidationSettlementState storage state = accountLayout.settlementStates[partyA][partyBs[i]];
			remainingCva += state.cva;
			if (state.actualAmount < 0) remainingClaims += uint256(-state.actualAmount);
		}

		uint256 remainingPool;
		uint256 remainingDeficit;
		if (resources >= 0) {
			remainingPool = Math.min(uint256(resources), remainingCva);
			_setAsideForPartyA(accountLayout, partyA, uint256(resources) - remainingPool);
		} else {
			remainingDeficit = Math.min(uint256(-resources), remainingClaims);
		}

		for (uint256 i = 0; i < count; i++) {
			LiquidationSettlementState storage state = accountLayout.settlementStates[partyA][partyBs[i]];
			uint256 cva = state.cva;
			if (cva > 0) {
				uint256 share = remainingCva <= cva ? remainingPool : (cva * remainingPool) / remainingCva;
				state.cva = share;
				remainingPool -= share;
				remainingCva -= cva;
			}
			int256 actualAmount = state.actualAmount;
			if (actualAmount < 0 && remainingDeficit > 0) {
				uint256 claim = uint256(-actualAmount);
				uint256 share = remainingClaims <= claim ? remainingDeficit : (claim * remainingDeficit) / remainingClaims;
				state.actualAmount = actualAmount + int256(share);
				remainingDeficit -= share;
				remainingClaims -= claim;
			}
			LibAccount.syncPartyBLiquidationSettlementReserve(accountLayout, partyA, partyBs[i], state.actualAmount);
		}
	}

	/// @dev Applies the still-needed reduction to one bucket. Positive reductions consume positive planned amounts;
	///      negative reductions consume negative ones. The expected amount follows, so funding is not rescaled for it.
	///      The returned remainder carries over to the next bucket. Also serves the pre-upgrade lazy path at settlement.
	function _capSettlementToSmallerUpnl(LiquidationSettlementState storage settlementState, int256 remainingReduction) private returns (int256) {
		int256 actualAmount = settlementState.actualAmount;
		if (remainingReduction == 0 || actualAmount == 0 || (remainingReduction > 0) != (actualAmount > 0)) return remainingReduction;

		int256 sign = remainingReduction > 0 ? int256(1) : int256(-1);
		int256 reduction = sign * int256(Math.min(SignedMath.abs(actualAmount), SignedMath.abs(remainingReduction)));
		settlementState.actualAmount = actualAmount - reduction;

		int256 expectedAmount = settlementState.expectedAmount;
		if (expectedAmount != 0 && (expectedAmount > 0) == (reduction > 0)) {
			settlementState.expectedAmount = expectedAmount - sign * int256(Math.min(SignedMath.abs(expectedAmount), SignedMath.abs(reduction)));
		}
		return remainingReduction - reduction;
	}

	function _smallerSameDirectionUpnl(int256 signedUpnl, int256 settledUpnl) private pure returns (int256) {
		if (signedUpnl > 0 && settledUpnl > 0) return signedUpnl < settledUpnl ? signedUpnl : settledUpnl;
		if (signedUpnl < 0 && settledUpnl < 0) return signedUpnl > settledUpnl ? signedUpnl : settledUpnl;
		return 0;
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
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		accountLayout.liquidationDetails[partyA].disputed = disputed;
		require(partyBs.length == amounts.length, "LiquidationFacet: Invalid length");
		// A privileged resolution replaces the automatic payment plan, including any unconsumed cap.
		delete accountLayout.partyALiquidationRoundingReduction[partyA];

		// Override PartyB settlement buckets and keep settlement reserves in sync.
		for (uint256 i = 0; i < partyBs.length; i++) {
			require(accountLayout.settlementStates[partyA][partyBs[i]].pending, "LiquidationFacet: PartyB is not in settlement");
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
		int256 remainingReduction = accountLayout.partyALiquidationRoundingReduction[partyA];
		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];

			// Settle one PartyB bucket and release its CVA.
			partyB.requireNotCrossLiquidating();
			LiquidationSettlementState storage settlementState = accountLayout.settlementStates[partyA][partyB];
			require(settlementState.pending, "LiquidationFacet: PartyB is not in settlement");
			remainingReduction = _capSettlementToSmallerUpnl(settlementState, remainingReduction);
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

			// The planned amount is paid as is; the allocation bucket is mutated below so the funding and
			// realized-PnL components can each carry their own balance-change type. A cross-mode PartyB converts
			// unrealized profit into allocation first via settlePartyBUpnlForLiquidation. An isolated PartyB's
			// allocation cannot fall below the planned amount once its bucket was counted, so that check is an
			// invariant; a dispute resolution or the clearing-house takeover handles the case where it ever fails.
			if (partyAReceivableFromPartyB > 0 && partyBAllocatedBalance < uint256(partyAReceivableFromPartyB)) {
				revert(
					maLayout.crossModeEnabledForPartyB[partyB]
						? "LiquidationFacet: Settle cross partyB uPNL first"
						: "LiquidationFacet: Settlement exceeds PartyB allocation"
				);
			}
			settleAmounts[i] = partyAReceivableFromPartyB;
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
		accountLayout.partyALiquidationRoundingReduction[partyA] = remainingReduction;

		// Once every PartyB bucket is settled, release PartyA-side balances and close the liquidation.
		if (accountLayout.liquidationDetails[partyA].involvedPartyBCounts == 0) {
			require(remainingReduction == 0, "LiquidationFacet: Invalid rounding cap");
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
		delete accountLayout.partyALiquidationRoundingReduction[partyA];
		delete accountLayout.partyALiquidationPartyBs[partyA];
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
			return (LibSymbolAdjustment.liquidationPriceInStoredUnits(quote, price.price), LibQuoteFunding.getAccumulatedFundingFee(quote.id));
		}

		// Snapshot flow uses Muon-signed PartyB-symbol state captured at liquidation time.
		LiquidationPartyBSymbolSnapshot storage snapshot = accountLayout.liquidationPartyBSymbolSnapshots[partyA][liquidationDetail.liquidationId][
			quote.partyB
		][quote.symbolId];
		require(snapshot.isSet, "LiquidationFacet: Missing signed state");
		return (
			LibSymbolAdjustment.liquidationPriceInStoredUnits(quote, snapshot.price),
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
