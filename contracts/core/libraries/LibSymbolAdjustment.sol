// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment, AdjustmentState } from "../storages/SymbolAdjustmentStorage.sol";
import { Quote } from "../storages/QuoteStorage.sol";
import { LibQuoteAdjustment } from "./LibQuoteAdjustment.sol";

/// @title LibSymbolAdjustment
/// @notice Freeze checks and factor helpers for the corporate-action adjustment system
library LibSymbolAdjustment {
	/// @notice A symbol is frozen iff its adjustment is SCHEDULED and past its effective time, or a restatement window is open
	function isFrozen(uint256 symbolId) internal view returns (bool) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		if (adjustment.restating) return true;
		return adjustment.state == AdjustmentState.SCHEDULED && block.timestamp >= adjustment.effectiveTimestamp;
	}

	function requireNotFrozen(uint256 symbolId) internal view {
		require(!isFrozen(symbolId), "LibSymbolAdjustment: Symbol is frozen");
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

	/// @notice Marks that a quote mutation occurred during the current restatement window.
	/// @dev Used to prevent aborting after either a physical quote rewrite or a pending-inventory removal.
	function recordRestatementMutation(uint256 symbolId) internal {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		if (!adjustment.restating) return;
		adjustment.restatementMutated = true;
	}
}
