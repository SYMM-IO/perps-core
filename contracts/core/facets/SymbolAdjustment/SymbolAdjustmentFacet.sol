// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import {
	SymbolAdjustmentStorage,
	SymbolAdjustment,
	AdjustmentState,
	RestatementPhase,
	RestatementInventoryTotals
} from "../../storages/SymbolAdjustmentStorage.sol";
import { QuoteStorage, Quote, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { FundingStorage } from "../../storages/FundingStorage.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";
import { LibSymbolAdjustmentFunding } from "../../libraries/LibSymbolAdjustmentFunding.sol";
import { LibSymbolAdjustmentInventory } from "../../libraries/LibSymbolAdjustmentInventory.sol";
import { LibMuon } from "../../libraries/muon/LibMuon.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibAggregateFunding } from "../../libraries/LibAggregateFunding.sol";
import { LibPartyBState } from "../../libraries/extensions/LibPartyBState.sol";
import { LibQuoteAdjustment, QuoteAdjustmentData } from "../../libraries/LibQuoteAdjustment.sol";
import { ISymbolAdjustmentFacet } from "./ISymbolAdjustmentFacet.sol";

contract SymbolAdjustmentFacet is Accessibility, ISymbolAdjustmentFacet {
	using LibPartyBState for address;

	uint256 internal constant MIN_FACTOR = 1e16; // 0.01x
	uint256 internal constant MAX_FACTOR = 100e18; // 100x

	/// @notice Registers a corporate-action adjustment. A past effectiveTimestamp freezes the symbol immediately (emergency path).
	/// @dev Only the latest adjustment is stored; full history is reconstructed from events (see SymbolAdjustment).
	function scheduleAdjustment(
		uint256 symbolId,
		uint256 factor,
		uint256 effectiveTimestamp
	) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[symbolId];
		require(symbolId >= 1 && symbolId <= SymbolStorage.layout().lastId, "SymbolAdjustmentFacet: Invalid symbolId");
		require(factor >= MIN_FACTOR && factor <= MAX_FACTOR && factor != 1e18, "SymbolAdjustmentFacet: Invalid factor");
		require(!adjustment.restating, "SymbolAdjustmentFacet: Restatement in progress");
		require(!LibSymbolAdjustment.hasScheduledAdjustment(symbolId), "SymbolAdjustmentFacet: Adjustment already in flight");
		adjustment.factor = factor;
		adjustment.effectiveTimestamp = effectiveTimestamp;
		adjustment.state = AdjustmentState.SCHEDULED;
		adjustment.scheduledCount += 1;
		adjustmentLayout.adjustmentScheduledAt[symbolId] = block.timestamp;
		emit AdjustmentScheduled(symbolId, adjustment.scheduledCount - 1, factor, effectiveTimestamp);
	}

	/// @notice Cancels the in-flight SCHEDULED adjustment when no restatement window is open. Allowed after effective time.
	function cancelAdjustment(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.state != AdjustmentState.NONE, "SymbolAdjustmentFacet: No adjustment");
		require(adjustment.state == AdjustmentState.SCHEDULED, "SymbolAdjustmentFacet: Invalid state");
		require(!adjustment.restating, "SymbolAdjustmentFacet: Restatement in progress");
		adjustment.state = AdjustmentState.CANCELLED;
		emit AdjustmentCancelled(symbolId, adjustment.scheduledCount - 1);
	}

	/// @notice Ops confirms the oracle applies the factor; activates the factor and unfreezes the symbol.
	function confirmPriceAdjusted(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.state != AdjustmentState.NONE, "SymbolAdjustmentFacet: No adjustment");
		require(adjustment.state == AdjustmentState.SCHEDULED, "SymbolAdjustmentFacet: Invalid state");
		require(!adjustment.restating, "SymbolAdjustmentFacet: Restatement in progress");
		require(block.timestamp >= adjustment.effectiveTimestamp, "SymbolAdjustmentFacet: Not effective yet");
		uint256 newCumulative = _prospectiveCumulativeFactor(symbolId, adjustment);
		require(newCumulative != 0, "SymbolAdjustmentFacet: Cumulative factor underflow");
		adjustment.state = AdjustmentState.PRICE_ADJUSTED;
		adjustment.cumulativeFactor = newCumulative;
		emit PriceAdjustmentConfirmed(symbolId, adjustment.scheduledCount - 1, newCumulative);
	}

	/// @notice Opens a frozen restatement window either directly from an effective SCHEDULED adjustment or from an already-active factor.
	/// @dev Direct restatement avoids activating the scheduled factor in `cumulativeFactor`; Muon and normal trading never use that temporary basis.
	///      The operator must supply the relevant PartyBs and complete funding preparation before quote mutation can begin.
	function startRestatement(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[symbolId];
		require(!adjustment.restating, "SymbolAdjustmentFacet: Already restating");
		uint256 factor;
		if (adjustment.state == AdjustmentState.SCHEDULED) {
			require(block.timestamp >= adjustment.effectiveTimestamp, "SymbolAdjustmentFacet: Not effective yet");
			factor = _prospectiveCumulativeFactor(symbolId, adjustment);
		} else {
			factor = LibSymbolAdjustment.activeCumulativeFactor(symbolId);
		}
		require(factor != 0, "SymbolAdjustmentFacet: Cumulative factor underflow");
		require(factor != 1e18, "SymbolAdjustmentFacet: No adjustment factor");
		// Record when the symbol became continuously frozen. A future schedule freezes at its effective time,
		// while a past-effective emergency schedule cannot freeze the symbol before it exists on-chain.
		if (LibSymbolAdjustment.isFrozen(symbolId)) {
			uint256 scheduledAt = adjustmentLayout.adjustmentScheduledAt[symbolId];
			adjustment.restatementStartedAt = adjustment.effectiveTimestamp > scheduledAt ? adjustment.effectiveTimestamp : scheduledAt;
		} else {
			adjustment.restatementStartedAt = block.timestamp;
		}
		adjustment.restating = true;
		adjustment.restatementMutated = false;
		adjustment.restatementFactor = factor;
		adjustment.restatementEpoch += 1;
		adjustment.fundingCutoffTimestamp = block.timestamp;
		adjustment.pendingFundingPartyBCount = 0;
		adjustment.fundingRestorationTimestamp = 0;
		adjustment.fundingSettlementRequired = false;
		delete adjustmentLayout.restatementInventoryTotals[symbolId];
		delete adjustmentLayout.restatementFundingSettlementTotals[symbolId];
		adjustment.restatementPhase = RestatementPhase.FUNDING_PREPARATION;
		emit RestatementStarted(symbolId, adjustment.restatementEpoch, factor);
	}

	/// @notice Processes only the operator-supplied PartyBs for preparation, abort restoration, or finalization restoration.
	function processRestatementFunding(uint256 symbolId, address[] calldata partyBs) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		require(partyBs.length > 0, "SymbolAdjustmentFacet: Empty PartyB batch");
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");

		if (adjustment.restatementPhase == RestatementPhase.FUNDING_PREPARATION) {
			uint256 newlyPreparedPartyBCount = LibSymbolAdjustmentInventory.preparePartyBs(symbolId, adjustment.restatementEpoch, partyBs);
			uint256 fundingCheckpointedPartyBCount;
			if (FundingStorage.layout().accumulatedFundingActivated) {
				fundingCheckpointedPartyBCount = LibSymbolAdjustmentFunding.prepareFundingRatesForRestatement(
					symbolId,
					adjustment.restatementEpoch,
					adjustment.fundingCutoffTimestamp,
					partyBs
				);
			}
			RestatementInventoryTotals storage inventoryTotals = SymbolAdjustmentStorage.layout().restatementInventoryTotals[symbolId];
			emit RestatementPreparationProgress(
				symbolId,
				adjustment.restatementEpoch,
				partyBs.length,
				newlyPreparedPartyBCount,
				fundingCheckpointedPartyBCount,
				inventoryTotals.remainingLong,
				inventoryTotals.remainingShort,
				adjustment.pendingFundingPartyBCount
			);
			return;
		}

		bool finalizing = adjustment.restatementPhase == RestatementPhase.FINALIZATION_FUNDING_RESTORATION;
		require(
			finalizing || adjustment.restatementPhase == RestatementPhase.ABORT_FUNDING_RESTORATION,
			"SymbolAdjustmentFacet: Invalid funding phase"
		);
		(uint256 processedPartyBs, uint256 remainingPartyBs) = LibSymbolAdjustmentFunding.restoreFundingRates(
			symbolId,
			adjustment.restatementEpoch,
			finalizing ? adjustment.restatementFactor : 1e18,
			finalizing,
			adjustment.fundingRestorationTimestamp,
			partyBs
		);
		emit RestatementFundingRestorationProgress(symbolId, adjustment.restatementEpoch, finalizing, processedPartyBs, remainingPartyBs);
		if (remainingPartyBs == 0) {
			if (finalizing) _completeFinalization(symbolId, adjustment);
			else _completeAbort(symbolId, adjustment);
		}
	}

	/// @notice Seals the operator-supplied PartyB manifest and starts funding settlement before quote processing.
	function completeRestatementFundingPreparation(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		require(adjustment.restatementPhase == RestatementPhase.FUNDING_PREPARATION, "SymbolAdjustmentFacet: Invalid funding phase");
		RestatementInventoryTotals storage inventoryTotals = SymbolAdjustmentStorage.layout().restatementInventoryTotals[symbolId];
		RestatementInventoryTotals storage fundingTotals = SymbolAdjustmentStorage.layout().restatementFundingSettlementTotals[symbolId];
		// Snapshot the switch here: rewrites check this flag, never the live global, so flipping the switch mid-window is harmless.
		bool fundingSettlementRequired = FundingStorage.layout().accumulatedFundingActivated;
		adjustment.fundingSettlementRequired = fundingSettlementRequired;
		adjustment.restatementPhase =
			fundingSettlementRequired && (fundingTotals.remainingLong != 0 || fundingTotals.remainingShort != 0)
				? RestatementPhase.FUNDING_SETTLEMENT
				: RestatementPhase.QUOTE_PROCESSING;
		emit RestatementPreparationCompleted(
			symbolId,
			adjustment.restatementEpoch,
			inventoryTotals.remainingLong,
			inventoryTotals.remainingShort,
			adjustment.pendingFundingPartyBCount,
			adjustment.restatementPhase
		);
	}

	/// @notice Starts an abort for a mutation-free window and completes immediately when no rates were checkpointed.
	function abortRestatement(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		require(!adjustment.restatementMutated, "SymbolAdjustmentFacet: Restatement already mutated");
		require(
			adjustment.restatementPhase == RestatementPhase.FUNDING_PREPARATION ||
				adjustment.restatementPhase == RestatementPhase.FUNDING_SETTLEMENT ||
				adjustment.restatementPhase == RestatementPhase.QUOTE_PROCESSING,
			"SymbolAdjustmentFacet: Invalid funding phase"
		);
		adjustment.restatementPhase = RestatementPhase.ABORT_FUNDING_RESTORATION;
		uint256 pendingPartyBs = LibSymbolAdjustmentFunding.pendingFundingPartyBs(symbolId);
		emit RestatementFundingRestorationStarted(symbolId, adjustment.restatementEpoch, false, pendingPartyBs);
		if (pendingPartyBs == 0) _completeAbort(symbolId, adjustment);
	}

	/// @notice Processes quotes in two batched passes when accumulated funding is active: funding settlement, then unit restatement.
	/// @dev The factor comes from the registry; callers only choose which quotes. A PartyB may process its own quotes,
	///      while SYMBOL_MANAGER_ROLE may process any quote.
	function applyAdjustment(uint256 symbolId, uint256[] calldata quoteIds) external {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		RestatementPhase phase = adjustment.restatementPhase;
		require(
			phase == RestatementPhase.FUNDING_SETTLEMENT || phase == RestatementPhase.QUOTE_PROCESSING,
			"SymbolAdjustmentFacet: Funding preparation incomplete"
		);
		uint256 epoch = adjustment.restatementEpoch;
		uint256 factor = adjustment.restatementFactor;
		bool isManager = LibAccessibility.hasRole(msg.sender, LibAccessibility.SYMBOL_MANAGER_ROLE);
		if (phase == RestatementPhase.FUNDING_SETTLEMENT) {
			for (uint256 i = 0; i < quoteIds.length; i++) {
				_settleQuoteFunding(quoteIds[i], symbolId, epoch, isManager);
			}
			LibSymbolAdjustmentInventory.completeFundingSettlementIfDone(symbolId, adjustment);
			return;
		}
		for (uint256 i = 0; i < quoteIds.length; i++) {
			_restateQuote(quoteIds[i], symbolId, epoch, factor, isManager);
		}
	}

	function _settleQuoteFunding(uint256 quoteId, uint256 symbolId, uint256 epoch, bool isManager) internal {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.symbolId == symbolId, "SymbolAdjustmentFacet: Wrong symbol");
		require(isManager || msg.sender == quote.partyB, "SymbolAdjustmentFacet: Not partyB of quote");
		require(
			quote.quoteStatus == QuoteStatus.OPENED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"SymbolAdjustmentFacet: Invalid quote state"
		);
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "SymbolAdjustmentFacet: PartyA in liquidation");
		quote.partyB.requireNotLiquidating(quote.partyA);

		LibQuoteFunding.chargeAccumulatedFundingFee(quoteId);
		LibAccount.increaseBothUpnlCounters(quote.partyB, quote.partyA);
		LibSymbolAdjustmentInventory.consumeFundingSettlementAmount(quote, epoch);
	}

	function _restateQuote(uint256 quoteId, uint256 symbolId, uint256 epoch, uint256 factor, bool isManager) internal {
		SymbolAdjustmentStorage.Layout storage layout = SymbolAdjustmentStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.symbolId == symbolId, "SymbolAdjustmentFacet: Wrong symbol");
		require(isManager || msg.sender == quote.partyB, "SymbolAdjustmentFacet: Not partyB of quote");
		require(layout.quoteRestatedEpoch[quoteId] < epoch, "SymbolAdjustmentFacet: Already restated");
		require(
			quote.quoteStatus == QuoteStatus.OPENED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"SymbolAdjustmentFacet: Invalid quote state"
		);
		LibSymbolAdjustmentInventory.requirePrepared(symbolId, quote.partyB, epoch);
		// Same liquidation guards as LibQuoteClose.expireQuote
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "SymbolAdjustmentFacet: PartyA in liquidation");
		quote.partyB.requireNotLiquidating(quote.partyA);

		// 1) Funding was settled for the complete prepared inventory before any quote mutation began.
		require(
			layout.quoteFundingSettledEpoch[quoteId] == epoch || !layout.adjustments[symbolId].fundingSettlementRequired,
			"SymbolAdjustmentFacet: Funding not settled"
		);
		// Funding settlement invalidated the balance change; invalidate again at the later quote-basis mutation.
		LibAccount.increaseBothUpnlCounters(quote.partyB, quote.partyA);

		// 2) Remove aggregates computed from the old amount and openedPrice before any mutation.
		uint256 oldOpenAmount = LibQuote.quoteOpenAmount(quote);
		LibQuote.subFromPartiesAggregatedPositions(quote, oldOpenAmount);

		// 3) Scale amounts by the factor; recompute prices from notional so rounding dust lands in price, not value.
		uint256 oldQuantity = quote.quantity;
		uint256 oldOpenedPrice = quote.openedPrice;
		QuoteAdjustmentPreview memory preview = _previewQuote(quote, factor);
		quote.quantity = preview.quantity;
		quote.openedPrice = preview.openedPrice;
		quote.initialOpenedPrice = preview.initialOpenedPrice;
		quote.requestedOpenPrice = preview.requestedOpenPrice;
		quote.marketPrice = preview.marketPrice;
		quote.closedAmount = preview.closedAmount;
		quote.avgClosedPrice = preview.avgClosedPrice;
		quote.quantityToClose = preview.quantityToClose;
		quote.requestedClosePrice = preview.requestedClosePrice;

		// 4) Re-add aggregates from the NEW amount and NEW openedPrice.
		uint256 newOpenAmount = LibQuote.quoteOpenAmount(quote);
		LibQuote.addToPartyBAggregatedPositions(quote, newOpenAmount);
		LibQuote.addToPartyAAggregatedPositions(quote, newOpenAmount);
		LibAggregateFunding.addToPartiesAggregateFunding(quote, newOpenAmount);

		// 5) Stamp so this quote cannot be restated twice in the same window.
		layout.quoteRestatedEpoch[quoteId] = epoch;
		LibSymbolAdjustment.recordRestatementMutation(symbolId);
		emit QuoteAdjusted(quoteId, symbolId, epoch, factor, oldQuantity, preview.quantity, oldOpenedPrice, quote.openedPrice);
	}

	/// @notice Cancels PENDING/LOCKED/CANCEL_PENDING quotes on a frozen symbol because they are priced in
	///         pre-adjustment units. The trading fee is refunded and pending locks are released.
	function cancelPendingQuotes(uint256[] calldata quoteIds) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = QuoteStorage.layout().quotes[quoteIds[i]];
			uint256 symbolId = quote.symbolId;
			require(LibSymbolAdjustment.isFrozen(quote.symbolId), "SymbolAdjustmentFacet: Symbol not frozen");
			require(
				quote.quoteStatus == QuoteStatus.PENDING ||
					quote.quoteStatus == QuoteStatus.LOCKED ||
					quote.quoteStatus == QuoteStatus.CANCEL_PENDING,
				"SymbolAdjustmentFacet: Invalid quote state"
			);
			LibQuoteClose.forceCancelPendingQuote(quoteIds[i]);
			emit PendingQuoteCancelledByAdjustment(quoteIds[i], symbolId);
		}
	}

	/// @notice Starts funding restoration for finalization and completes immediately when no rates were checkpointed.
	function finalizeRestatement(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		require(adjustment.restatementPhase == RestatementPhase.QUOTE_PROCESSING, "SymbolAdjustmentFacet: Funding preparation incomplete");
		RestatementInventoryTotals storage inventoryTotals = SymbolAdjustmentStorage.layout().restatementInventoryTotals[symbolId];
		require(
			inventoryTotals.remainingLong == 0 && inventoryTotals.remainingShort == 0,
			"SymbolAdjustmentFacet: Open-position restatement incomplete"
		);
		// Finalization is the instant stored quotes change meaning. Wait until every old-basis signature is expired.
		require(
			block.timestamp > adjustment.restatementStartedAt + LibMuon.maxUpnlValidTime(),
			"SymbolAdjustmentFacet: Restatement window too short"
		);
		adjustment.restatementPhase = RestatementPhase.FINALIZATION_FUNDING_RESTORATION;
		adjustment.fundingRestorationTimestamp = block.timestamp;
		uint256 pendingPartyBs = LibSymbolAdjustmentFunding.pendingFundingPartyBs(symbolId);
		emit RestatementFundingRestorationStarted(symbolId, adjustment.restatementEpoch, true, pendingPartyBs);
		if (pendingPartyBs == 0) _completeFinalization(symbolId, adjustment);
	}

	function _completeFinalization(uint256 symbolId, SymbolAdjustment storage adjustment) private {
		if (adjustment.state == AdjustmentState.PRICE_ADJUSTED || adjustment.state == AdjustmentState.SCHEDULED) {
			adjustment.state = AdjustmentState.APPLIED;
		}
		adjustment.cumulativeFactor = 1e18;
		adjustment.restating = false;
		adjustment.restatementFactor = 0;
		adjustment.restatementStartedAt = 0;
		adjustment.basisVersion += 1;
		_clearRestatementProgress(symbolId, adjustment);
		emit RestatementFinalized(symbolId, adjustment.restatementEpoch);
	}

	function _completeAbort(uint256 symbolId, SymbolAdjustment storage adjustment) private {
		adjustment.restating = false;
		adjustment.restatementFactor = 0;
		adjustment.restatementStartedAt = 0;
		_clearRestatementProgress(symbolId, adjustment);
		emit RestatementAborted(symbolId, adjustment.restatementEpoch);
	}

	function _clearRestatementProgress(uint256 symbolId, SymbolAdjustment storage adjustment) private {
		adjustment.restatementPhase = RestatementPhase.NONE;
		adjustment.fundingCutoffTimestamp = 0;
		adjustment.pendingFundingPartyBCount = 0;
		adjustment.fundingRestorationTimestamp = 0;
		adjustment.fundingSettlementRequired = false;
		delete SymbolAdjustmentStorage.layout().restatementInventoryTotals[symbolId];
		delete SymbolAdjustmentStorage.layout().restatementFundingSettlementTotals[symbolId];
	}

	// ---- Views ----

	function _prospectiveCumulativeFactor(uint256 symbolId, SymbolAdjustment storage adjustment) internal view returns (uint256) {
		uint256 activeFactor = LibSymbolAdjustment.activeCumulativeFactor(symbolId);
		if (adjustment.state != AdjustmentState.SCHEDULED) return activeFactor;
		return Math.mulDiv(activeFactor, adjustment.factor, 1e18);
	}

	function _previewQuote(Quote storage quote, uint256 factor) internal pure returns (QuoteAdjustmentPreview memory preview) {
		Quote memory quoteSnapshot = quote;
		QuoteAdjustmentData memory result = LibQuoteAdjustment.preview(quoteSnapshot, factor);
		return
			QuoteAdjustmentPreview({
				factor: result.factor,
				quantity: result.quantity,
				openedPrice: result.openedPrice,
				initialOpenedPrice: result.initialOpenedPrice,
				requestedOpenPrice: result.requestedOpenPrice,
				marketPrice: result.marketPrice,
				closedAmount: result.closedAmount,
				avgClosedPrice: result.avgClosedPrice,
				quantityToClose: result.quantityToClose,
				requestedClosePrice: result.requestedClosePrice
			});
	}
}
