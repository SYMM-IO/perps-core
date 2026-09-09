// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment, AdjustmentState } from "../storages/SymbolAdjustmentStorage.sol";
import { Quote, QuoteStatus } from "../storages/QuoteStorage.sol";
import { LibQuoteAdjustment } from "./LibQuoteAdjustment.sol";

/// @title LibSymbolAdjustment
/// @notice Freeze checks and factor helpers for the corporate-action adjustment system
library LibSymbolAdjustment {
	error PendingQuoteIsStale();

	/// @notice A symbol is frozen iff its adjustment is SCHEDULED and past its effective time, or a restatement window is open
	function isFrozen(uint256 symbolId) internal view returns (bool) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		if (adjustment.restating) return true;
		return adjustment.state == AdjustmentState.SCHEDULED && block.timestamp >= adjustment.effectiveTimestamp;
	}

	function requireNotFrozen(uint256 symbolId) internal view {
		require(!isFrozen(symbolId), "LibSymbolAdjustment: Symbol is frozen");
	}

	/// @notice Allows a liquidation close through the symbol freeze only while a physical restatement window is open.
	/// @dev An effective SCHEDULED adjustment without an open restatement remains blocked. This keeps the ordinary
	///      freeze intact while letting liquidation remove inventory that the restatement counters already track.
	function requireLiquidationAllowed(uint256 symbolId) internal view {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		require(!isFrozen(symbolId) || adjustment.restating, "LibSymbolAdjustment: Symbol is frozen");
	}

	/// @notice Requires a liquidation price payload for a restating symbol to postdate the window's basis boundary.
	/// @dev Strict inequality removes same-block ordering ambiguity because Muon payloads do not carry restatement epochs.
	function requireCurrentLiquidationSignature(uint256 symbolId, uint256 signatureTimestamp) internal view {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		requireLiquidationAllowed(symbolId);
		if (adjustment.restating) {
			require(signatureTimestamp > adjustment.restatementStartedAt, "LibSymbolAdjustment: Liquidation signature predates restatement");
		}
	}

	/// @notice Converts a venue-basis liquidation price into the quote's current stored price basis.
	/// @dev Liquidation price payloads use venue units during an open restatement. Quotes already rewritten in the
	///      current epoch also use venue units and need no conversion. For an old-basis quote, the conversion uses the
	///      same rounded total-quantity ratio as physical restatement so current-price notional follows the normalized
	///      quote. If that total quantity rounds to zero, the direct factor is the deterministic dust fallback.
	function liquidationPriceInStoredUnits(Quote storage quote, uint256 venuePrice) internal view returns (uint256) {
		SymbolAdjustmentStorage.Layout storage layout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = layout.adjustments[quote.symbolId];
		if (!adjustment.restating || layout.quoteRestatedEpoch[quote.id] >= adjustment.restatementEpoch) return venuePrice;

		uint256 adjustedQuantity = Math.mulDiv(quote.quantity, adjustment.restatementFactor, 1e18);
		if (adjustedQuantity == 0) return Math.mulDiv(venuePrice, adjustment.restatementFactor, 1e18);
		return Math.mulDiv(adjustedQuantity, venuePrice, quote.quantity);
	}

	/// @notice True if the symbol has a SCHEDULED (not yet confirmed/cancelled) adjustment, effective or not
	function hasScheduledAdjustment(uint256 symbolId) internal view returns (bool) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId].state == AdjustmentState.SCHEDULED;
	}

	/// @notice Current cumulative price factor (1e18 when unset)
	function activeCumulativeFactor(uint256 symbolId) internal view returns (uint256) {
		uint256 f = SymbolAdjustmentStorage.layout().adjustments[symbolId].cumulativeFactor;
		return f == 0 ? 1e18 : f;
	}

	/// @notice Current physical price/quantity basis version for a symbol.
	function basisVersion(uint256 symbolId) internal view returns (uint256) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId].basisVersion;
	}

	/// @notice Highest quote ID that belongs to an older physical basis for a symbol.
	function pendingQuoteIdCutoff(uint256 symbolId) internal view returns (uint256) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId].pendingQuoteIdCutoff;
	}

	/// @notice True when a pending quote predates the symbol's latest completed physical restatement.
	function isPendingQuoteStale(Quote storage quote) internal view returns (bool) {
		// The three pending states are contiguous and precede CANCELED in QuoteStatus.
		if (quote.quoteStatus > QuoteStatus.CANCEL_PENDING) return false;
		return quote.id != 0 && quote.id <= pendingQuoteIdCutoff(quote.symbolId);
	}

	function requirePendingQuoteCurrent(Quote storage quote) internal view {
		if (isPendingQuoteStale(quote)) revert PendingQuoteIsStale();
	}

	/// @notice True when the applicable physical-restatement factor cannot preserve every nonzero amount on an unrestated quote.
	/// @dev An already-restated quote never qualifies: applying the window factor to it again would test the wrong stored basis.
	function isUnrestatableDueToAmountRounding(Quote storage quote) internal view returns (bool) {
		SymbolAdjustmentStorage.Layout storage layout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = layout.adjustments[quote.symbolId];
		uint256 factor;

		if (adjustment.restating) {
			if (layout.quoteRestatedEpoch[quote.id] >= adjustment.restatementEpoch) return false;
			factor = adjustment.restatementFactor;
		} else if (adjustment.state == AdjustmentState.SCHEDULED) {
			factor = Math.mulDiv(activeCumulativeFactor(quote.symbolId), adjustment.factor, 1e18);
		} else {
			factor = activeCumulativeFactor(quote.symbolId);
		}

		if (factor == 0 || factor == 1e18) return false;
		Quote memory quoteSnapshot = quote;
		return LibQuoteAdjustment.hasAmountUnderflow(quoteSnapshot, factor);
	}

	/// @notice Marks that a basis-dependent mutation occurred during the current restatement window.
	/// @dev Used to prevent aborting after a physical quote rewrite or after a multi-step liquidation stores a
	///      venue-basis price that would be reinterpreted incorrectly if the window returned to the old basis.
	function recordRestatementMutation(uint256 symbolId) internal {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		if (!adjustment.restating) return;
		adjustment.restatementMutated = true;
	}
}
