// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment, AdjustmentState } from "../../storages/SymbolAdjustmentStorage.sol";
import { QuoteStorage, Quote, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";
import { LibSymbolAdjustmentFunding } from "../../libraries/LibSymbolAdjustmentFunding.sol";
import { LibMuon } from "../../libraries/muon/LibMuon.sol";
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
	///      Active current funding rates are rolled forward, checkpointed, and paused for the window.
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
		emit RestatementStarted(symbolId, adjustment.restatementEpoch, factor);
		LibSymbolAdjustmentFunding.prepareFundingRatesForRestatement(symbolId, adjustment.restatementEpoch);
	}

	/// @notice Aborts only a mutation-free window, restores paused funding rates, and returns to the prior adjustment state.
	function abortRestatement(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		require(!adjustment.restatementMutated, "SymbolAdjustmentFacet: Restatement already mutated");
		LibSymbolAdjustmentFunding.restoreAfterAbort(symbolId, adjustment.restatementEpoch);
		adjustment.restating = false;
		adjustment.restatementFactor = 0;
		adjustment.restatementStartedAt = 0;
		emit RestatementAborted(symbolId, adjustment.restatementEpoch);
	}

	/// @notice Restates quotes to post-adjustment units. The factor comes from the registry; callers only
	///         choose which quotes; a PartyB may restate its own quotes, SYMBOL_MANAGER_ROLE may restate any.
	function applyAdjustment(uint256 symbolId, uint256[] calldata quoteIds) external {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		uint256 epoch = adjustment.restatementEpoch;
		uint256 factor = adjustment.restatementFactor;
		bool isManager = LibAccessibility.hasRole(msg.sender, LibAccessibility.SYMBOL_MANAGER_ROLE);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			_restateQuote(quoteIds[i], symbolId, epoch, factor, isManager);
		}
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
		// Same liquidation guards as LibQuoteClose.expireQuote
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "SymbolAdjustmentFacet: PartyA in liquidation");
		quote.partyB.requireNotLiquidating(quote.partyA);

		// 1) Ensure this PartyB shares the window's zero-rate cutoff, then settle the quote's old-unit funding.
		//    Registered PartyBs are paused when the window opens; this fallback covers a legacy deregistered PartyB
		//    that still has an open quote.
		LibSymbolAdjustmentFunding.preparePartyBFundingRatesForRestatement(symbolId, quote.partyB, epoch);
		LibQuoteFunding.chargeAccumulatedFundingFee(quoteId);

		// 2) Remove aggregates computed from the old amount and openedPrice before any mutation.
		uint256 oldOpenAmount = LibQuote.quoteOpenAmount(quote);
		LibQuote.subFromPartiesAggregatedPositions(quote, oldOpenAmount);
		LibAggregateFunding.subFromPartiesAggregateFunding(quote, oldOpenAmount);

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

	/// @notice Force-expires PENDING/LOCKED/CANCEL_PENDING quotes on a frozen symbol (they are priced in
	///         pre-adjustment units). Uses expireQuote semantics: trading fee refunded, pending locks released.
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
			LibQuoteClose.forceExpireQuote(quoteIds[i]);
			emit PendingQuoteCancelledByAdjustment(quoteIds[i], symbolId);
		}
	}

	/// @notice Rebases paused funding rates, closes the window, marks the adjustment applied, clears factors, and unfreezes the symbol.
	function finalizeRestatement(uint256 symbolId) external onlyRole(LibAccessibility.SYMBOL_MANAGER_ROLE) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(adjustment.restating, "SymbolAdjustmentFacet: No restatement in progress");
		// Finalization is the instant stored quotes change meaning. Wait until every old-basis signature is expired.
		require(
			block.timestamp > adjustment.restatementStartedAt + LibMuon.maxUpnlValidTime(),
			"SymbolAdjustmentFacet: Restatement window too short"
		);
		LibSymbolAdjustmentFunding.restoreAfterFinalization(symbolId, adjustment.restatementEpoch, adjustment.restatementFactor);
		if (adjustment.state == AdjustmentState.PRICE_ADJUSTED || adjustment.state == AdjustmentState.SCHEDULED) {
			adjustment.state = AdjustmentState.APPLIED;
		}
		adjustment.cumulativeFactor = 1e18;
		adjustment.restating = false;
		adjustment.restatementFactor = 0;
		adjustment.restatementStartedAt = 0;
		adjustment.basisVersion += 1;
		emit RestatementFinalized(symbolId, adjustment.restatementEpoch);
	}

	// ---- Views ----

	function getSymbolAdjustment(uint256 symbolId) external view returns (SymbolAdjustment memory) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId];
	}

	function getCumulativeFactor(uint256 symbolId) external view returns (uint256) {
		return LibSymbolAdjustment.activeCumulativeFactor(symbolId);
	}

	/// @notice Returns the factor that confirmation would activate or direct restatement would select for the current scheduled adjustment.
	/// @dev Muon uses this value only for the active-factor route; getCumulativeFactor intentionally returns only confirmed trading state.
	function getProspectiveCumulativeFactor(uint256 symbolId) external view returns (uint256) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		return _prospectiveCumulativeFactor(symbolId, adjustment);
	}

	/// @notice Previews every quote field using the open window, scheduled prospective, or confirmed active factor and reverts on unsafe rounding.
	function previewQuoteAdjustment(uint256 symbolId, uint256 quoteId) external view returns (QuoteAdjustmentPreview memory preview) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.symbolId == symbolId, "SymbolAdjustmentFacet: Wrong symbol");
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		uint256 factor =
			adjustment.restating
				? adjustment.restatementFactor
				: adjustment.state == AdjustmentState.SCHEDULED
					? _prospectiveCumulativeFactor(symbolId, adjustment)
					: LibSymbolAdjustment.activeCumulativeFactor(symbolId);
		require(factor != 0, "SymbolAdjustmentFacet: Cumulative factor underflow");
		require(factor != 1e18, "SymbolAdjustmentFacet: No adjustment factor");
		return _previewQuote(quote, factor);
	}

	function isSymbolFrozen(uint256 symbolId) external view returns (bool) {
		return LibSymbolAdjustment.isFrozen(symbolId);
	}

	function getRestatementState(uint256 symbolId) external view returns (bool restating, uint256 epoch) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		return (adjustment.restating, adjustment.restatementEpoch);
	}

	function getQuoteRestatedEpoch(uint256 quoteId) external view returns (uint256) {
		return SymbolAdjustmentStorage.layout().quoteRestatedEpoch[quoteId];
	}

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
