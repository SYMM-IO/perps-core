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

/// @notice Preparation, funding-settlement, quote-processing, and funding-restoration phase inside an open physical-restatement window.
enum RestatementPhase {
	NONE,
	FUNDING_PREPARATION,
	QUOTE_PROCESSING,
	ABORT_FUNDING_RESTORATION,
	FINALIZATION_FUNDING_RESTORATION,
	FUNDING_SETTLEMENT
}

/// @notice A symbol's corporate-action adjustment state. Only the latest adjustment is stored;
///         full history is reconstructed from events (AdjustmentScheduled / AdjustmentCancelled /
///         PriceAdjustmentConfirmed / RestatementStarted / funding progress / RestatementAborted /
///         QuoteAdjusted / PendingQuoteCancelledByAdjustment / RestatementFinalized), matching how
///         accumulated-funding history lives in events rather than storage.
struct SymbolAdjustment {
	/// @notice Latest scheduled adjustment's 1e18-scaled units multiplier: 4:1 split -> 4e18, 1:10 reverse split -> 0.1e18.
	/// @dev Used to calculate the prospective cumulative factor for either direct restatement or activation after Muon's adjusted price is confirmed.
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
	/// @dev Used by Muon-facing views and normal trading calculations. Direct restatement deliberately leaves it unchanged and uses
	///      `restatementFactor` instead; finalization resets it to 1e18 after all selected factors are folded into quote storage.
	uint256 cumulativeFactor;
	/// @notice Monotonically increasing identifier of the latest restatement window.
	/// @dev Stamped into `quoteRestatedEpoch` so the same quote cannot be rewritten twice in one window while still allowing a later window
	///      to rewrite it.
	uint256 restatementEpoch;
	/// @notice Whether a restatement maintenance window is currently open.
	/// @dev Freezes the symbol and gates quote rewrites, abort, and finalization to an explicitly opened window.
	bool restating;
	/// @notice Whether any quote rewrite occurred in the current restatement window.
	/// @dev Used only by `abortRestatement`: once true, abort is forbidden because reopening trading would expose partially restated inventory.
	///      This is a mutation-safety flag, not the open-position completeness check enforced by the inventory checkpoints below.
	bool restatementMutated;
	/// @notice 1e18-scaled factor selected for the current restatement window; 0 when no window is open.
	/// @dev Lets operations restate directly from SCHEDULED without activating `cumulativeFactor` for Muon or normal trading. Quote rewrites and
	///      normalized mixed-book views use this value until abort or finalization clears it.
	uint256 restatementFactor;
	/// @notice Monotonically increasing identifier of the symbol's physical price/quantity basis.
	/// @dev Advances only after a restatement finalizes. Deferred multi-transaction workflows bind to this value so values from the
	///      previous basis cannot be executed after quote storage has been rewritten. Muon payloads deliberately do NOT carry it:
	///      signatures stay backward compatible, and the equivalent guarantee comes from the minimum restatement window enforced
	///      in finalizeRestatement (see `restatementStartedAt`).
	uint256 basisVersion;
	/// @notice Timestamp from which the symbol has been continuously frozen for the current restatement window.
	/// @dev Set when the window opens. On the direct route, it is the later of the venue effective time and the on-chain scheduling
	///      time. finalizeRestatement refuses to advance `basisVersion` until signatures minted under the current validity
	///      configuration have expired.
	uint256 restatementStartedAt;
	/// @notice Current preparation and funding-restoration phase for the open restatement window.
	/// @dev Inventory and funding preparation share the first phase. Quote mutation is allowed only in QUOTE_PROCESSING.
	///      Abort and finalization stay frozen until saved rates are restored.
	RestatementPhase restatementPhase;
	/// @notice Shared funding cutoff selected when the restatement window opens.
	/// @dev Every operator-supplied PartyB batch rolls its rates to this timestamp, regardless of the batch transaction time.
	uint256 fundingCutoffTimestamp;
	/// @notice Number of PartyB funding checkpoints that still need restoration for this window.
	/// @dev Incremented only for nonzero pairs explicitly supplied by Operations or encountered through quote processing.
	uint256 pendingFundingPartyBCount;
	/// @notice Shared rate-resumption timestamp selected when finalization begins.
	/// @dev Batched restoration uses this timestamp so every PartyB resumes funding at one economic boundary.
	uint256 fundingRestorationTimestamp;
	/// @notice Whether the open window settles old-basis funding before quote rewrites.
	/// @dev Snapshotted from the global accumulated-funding switch when the PartyB manifest is sealed, so a switch flipped
	///      mid-window cannot change what a rewrite requires after quotes have already been rewritten.
	bool fundingSettlementRequired;
}

/// @notice Funding rates saved while a symbol is physically restated.
/// @dev Rates are shared by all quotes for one symbol/PartyB pair. Core pauses them once per
///      restatement window, then restores them on abort or rebases them on finalization.
struct FundingRateCheckpoint {
	int256 currentLongRate;
	int256 currentShortRate;
	uint256 restatementEpoch;
}

/// @notice Old-basis open quantity that still has to be restated or removed for one symbol/PartyB pair.
/// @dev LONG and SHORT are tracked independently so opposite exposures cannot cancel each other.
struct RestatementInventoryCheckpoint {
	uint256 restatementEpoch;
	uint256 remainingLong;
	uint256 remainingShort;
}

/// @notice Symbol-wide old-basis open quantity that still has to be restated or removed.
/// @dev LONG and SHORT totals equal the sum of the current epoch's prepared PartyB checkpoints.
struct RestatementInventoryTotals {
	uint256 remainingLong;
	uint256 remainingShort;
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
		/// @notice Block timestamp at which the latest adjustment was scheduled.
		/// @dev For a past-effective emergency adjustment, this is when the symbol actually became frozen on-chain.
		mapping(uint256 => uint256) adjustmentScheduledAt;
		/// @notice PartyBs whose nonzero current funding rates Core paused for the open restatement window.
		/// @dev Retained for storage-layout compatibility. Explicit operator batches use fundingRateCheckpoints and the per-window pending count.
		mapping(uint256 => address[]) restatementFundingPartyBs;
		/// @notice Saved current funding rates keyed by symbol and PartyB.
		/// @dev `restatementEpoch` makes stale checkpoints from earlier windows distinguishable even though mapping slots are reused.
		mapping(uint256 => mapping(address => FundingRateCheckpoint)) fundingRateCheckpoints;
		/// @notice Remaining old-basis open quantities keyed by symbol and operator-supplied PartyB.
		/// @dev Appended for storage compatibility. Epoch versioning makes stale checkpoints inert without an unbounded cleanup loop.
		mapping(uint256 => mapping(address => RestatementInventoryCheckpoint)) restatementInventoryCheckpoints;
		/// @notice Symbol-wide LONG and SHORT old-basis quantities remaining in the prepared PartyB manifest.
		/// @dev Finalization is blocked until both exact quantity totals reach zero for the current restatement epoch.
		mapping(uint256 => RestatementInventoryTotals) restatementInventoryTotals;
		/// @notice Symbol-wide old-basis quantities whose accumulated funding must be settled before any quote is rewritten.
		mapping(uint256 => RestatementInventoryTotals) restatementFundingSettlementTotals;
		/// @notice Last restatement epoch in which each quote's old-basis funding was settled during the funding-only pass.
		mapping(uint256 => uint256) quoteFundingSettledEpoch;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = SYMBOL_ADJUSTMENT_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
