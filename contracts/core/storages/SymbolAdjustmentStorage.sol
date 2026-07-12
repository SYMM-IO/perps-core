// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Lifecycle state of a symbol's corporate-action adjustment
enum AdjustmentState {
	NONE,
	SCHEDULED, // registered; freezes the symbol once effectiveTimestamp passes
	PRICE_ADJUSTED, // ops confirmed the oracle price factor is live; symbol unfrozen, factor active
	APPLIED, // symbol manager finalized restatement and reset the active factor
	CANCELLED
}

/// @notice A symbol's corporate-action adjustment state. Only the latest adjustment is stored;
///         full history is reconstructed from events (AdjustmentScheduled / AdjustmentCancelled /
///         PriceAdjustmentConfirmed / RestatementStarted / RestatementAborted / QuoteAdjusted /
///         PendingQuoteCancelledByAdjustment / RestatementFinalized), matching how accumulated-funding
///         history lives in events rather than storage.
struct SymbolAdjustment {
	/// @notice Latest scheduled adjustment's 1e18-scaled units multiplier: 4:1 split -> 4e18, 1:10 reverse split -> 0.1e18.
	/// @dev Used to calculate the prospective cumulative factor and then activate that factor when Muon's adjusted price is confirmed.
	uint256 factor;
	/// @notice Venue timestamp at which the latest scheduled adjustment takes effect.
	/// @dev Used to freeze trading automatically once due and to prevent price-factor confirmation before the venue has applied the adjustment.
	uint256 effectiveTimestamp;
	/// @notice Lifecycle state of the latest adjustment (NONE when the symbol never had one).
	/// @dev Gates scheduling, cancellation, price confirmation, and finalization, and helps determine whether the symbol must be frozen.
	AdjustmentState state;
	/// @notice Total adjustments ever scheduled for the symbol.
	/// @dev Supplies a stable zero-based event index (`scheduledCount - 1`) so off-chain consumers can distinguish successive adjustments.
	uint256 scheduledCount;
	/// @notice 1e18-scaled product of confirmed factors not yet absorbed by physical quote restatement; 0 means unset and is read as 1e18.
	/// @dev Used by Muon-facing views, trading calculations, and quote-restatement previews until finalization resets the active factor to 1e18.
	uint256 cumulativeFactor;
	/// @notice Monotonically increasing identifier of the latest restatement window.
	/// @dev Stamped into `quoteRestatedEpoch` so the same quote cannot be rewritten twice in one window while still allowing a later window
	///      to rewrite it.
	uint256 restatementEpoch;
	/// @notice Whether a restatement maintenance window is currently open.
	/// @dev Freezes the symbol and gates quote rewrites, abort, and finalization to an explicitly opened window.
	bool restating;
	/// @notice Whether any quote rewrite or pending-quote removal occurred in the current restatement window.
	/// @dev Used only by `abortRestatement`: once true, abort is forbidden because reopening trading would expose partially restated inventory.
	///      This is a mutation-safety flag, not a completeness check; finalization remains a SYMBOL_MANAGER_ROLE decision.
	bool restatementMutated;
}

/// @title SymbolAdjustmentStorage
/// @notice Corporate-action adjustment registry, cumulative price factor, and restatement bookkeeping
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library SymbolAdjustmentStorage {
	bytes32 internal constant SYMBOL_ADJUSTMENT_STORAGE_SLOT = keccak256("diamond.standard.storage.symboladjustment");

	struct Layout {
		/// @notice Stores the latest adjustment lifecycle and restatement state for each symbol.
		/// @dev This is the authoritative registry read by freeze checks, factor-aware pricing, and Symbol Adjustment actions and views.
		mapping(uint256 => SymbolAdjustment) adjustments;
		/// @notice Stores the last restatement epoch in which each quote was physically rewritten; 0 means never restated.
		/// @dev Compared with the quote's symbol epoch before mutation to reject duplicate rewrites within the same restatement window.
		mapping(uint256 => uint256) quoteRestatedEpoch;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = SYMBOL_ADJUSTMENT_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
