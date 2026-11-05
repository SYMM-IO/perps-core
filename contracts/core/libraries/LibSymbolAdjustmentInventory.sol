// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AggregatedDataStorage } from "../storages/AggregatedDataStorage.sol";
import {
	SymbolAdjustmentStorage,
	SymbolAdjustment,
	RestatementInventoryCheckpoint,
	RestatementInventoryTotals,
	RestatementPhase
} from "../storages/SymbolAdjustmentStorage.sol";
import { Quote, PositionType } from "../storages/QuoteStorage.sol";

/// @title LibSymbolAdjustmentInventory
/// @notice Proves that every old-basis open quantity for each operator-supplied PartyB is resolved before finalization.
library LibSymbolAdjustmentInventory {
	event RestatementInventoryPrepared(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		address indexed partyB,
		uint256 partyBRemainingLongAmount,
		uint256 partyBRemainingShortAmount,
		uint256 totalRemainingLongAmount,
		uint256 totalRemainingShortAmount
	);
	event RestatementInventoryConsumed(
		uint256 indexed symbolId,
		uint256 indexed epoch,
		uint256 indexed quoteId,
		address partyB,
		PositionType positionType,
		uint256 consumedAmount
	);
	event RestatementFundingSettlementCompleted(uint256 indexed symbolId, uint256 indexed epoch);

	/// @notice Snapshots each PartyB's current global open quantity exactly once in a restatement epoch.
	function preparePartyBs(
		uint256 symbolId,
		uint256 restatementEpoch,
		address[] calldata partyBs
	) internal returns (uint256 newlyPreparedPartyBCount) {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		RestatementInventoryTotals storage totals = adjustmentLayout.restatementInventoryTotals[symbolId];
		RestatementInventoryTotals storage fundingTotals = adjustmentLayout.restatementFundingSettlementTotals[symbolId];

		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];
			RestatementInventoryCheckpoint storage checkpoint = adjustmentLayout.restatementInventoryCheckpoints[symbolId][partyB];
			if (checkpoint.restatementEpoch == restatementEpoch) continue;

			uint256 remainingLong = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.LONG].aggregatedAmount;
			uint256 remainingShort = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.SHORT].aggregatedAmount;
			checkpoint.restatementEpoch = restatementEpoch;
			checkpoint.remainingLong = remainingLong;
			checkpoint.remainingShort = remainingShort;
			totals.remainingLong += remainingLong;
			totals.remainingShort += remainingShort;
			fundingTotals.remainingLong += remainingLong;
			fundingTotals.remainingShort += remainingShort;
			newlyPreparedPartyBCount += 1;
			emit RestatementInventoryPrepared(
				symbolId,
				restatementEpoch,
				partyB,
				remainingLong,
				remainingShort,
				totals.remainingLong,
				totals.remainingShort
			);
		}
	}

	/// @notice Requires that Operations included a PartyB before the preparation phase was sealed.
	function requirePrepared(uint256 symbolId, address partyB, uint256 restatementEpoch) internal view {
		require(
			SymbolAdjustmentStorage.layout().restatementInventoryCheckpoints[symbolId][partyB].restatementEpoch == restatementEpoch,
			"LibSymbolAdjustmentInventory: PartyB inventory not prepared"
		);
	}

	/// @notice Consumes an old-basis quantity when it is restated or removed from the open-position aggregates.
	/// @dev Before a PartyB is prepared, a preparation-phase close is observed by the later live aggregate snapshot.
	function consumeOldBasisAmount(Quote storage quote, uint256 amount) internal {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[quote.symbolId];
		if (!adjustment.restating || adjustmentLayout.quoteRestatedEpoch[quote.id] >= adjustment.restatementEpoch) return;

		RestatementPhase phase = adjustment.restatementPhase;
		if (
			phase != RestatementPhase.FUNDING_PREPARATION &&
			phase != RestatementPhase.FUNDING_SETTLEMENT &&
			phase != RestatementPhase.QUOTE_PROCESSING
		) return;

		RestatementInventoryCheckpoint storage checkpoint = adjustmentLayout.restatementInventoryCheckpoints[quote.symbolId][quote.partyB];
		if (checkpoint.restatementEpoch != adjustment.restatementEpoch) {
			require(phase == RestatementPhase.FUNDING_PREPARATION, "LibSymbolAdjustmentInventory: PartyB inventory not prepared");
			return;
		}

		RestatementInventoryTotals storage totals = adjustmentLayout.restatementInventoryTotals[quote.symbolId];
		bool fundingUnsettled = adjustmentLayout.quoteFundingSettledEpoch[quote.id] < adjustment.restatementEpoch;
		RestatementInventoryTotals storage fundingTotals = adjustmentLayout.restatementFundingSettlementTotals[quote.symbolId];
		if (quote.positionType == PositionType.LONG) {
			checkpoint.remainingLong -= amount;
			totals.remainingLong -= amount;
			if (fundingUnsettled) fundingTotals.remainingLong -= amount;
		} else {
			checkpoint.remainingShort -= amount;
			totals.remainingShort -= amount;
			if (fundingUnsettled) fundingTotals.remainingShort -= amount;
		}
		emit RestatementInventoryConsumed(quote.symbolId, adjustment.restatementEpoch, quote.id, quote.partyB, quote.positionType, amount);
		completeFundingSettlementIfDone(quote.symbolId, adjustment);
	}

	/// @notice Advances a FUNDING_SETTLEMENT window to QUOTE_PROCESSING once both settlement totals reach zero.
	function completeFundingSettlementIfDone(uint256 symbolId, SymbolAdjustment storage adjustment) internal returns (bool completed) {
		if (adjustment.restatementPhase != RestatementPhase.FUNDING_SETTLEMENT) return false;
		RestatementInventoryTotals storage fundingTotals = SymbolAdjustmentStorage.layout().restatementFundingSettlementTotals[symbolId];
		if (fundingTotals.remainingLong != 0 || fundingTotals.remainingShort != 0) return false;
		adjustment.restatementPhase = RestatementPhase.QUOTE_PROCESSING;
		emit RestatementFundingSettlementCompleted(symbolId, adjustment.restatementEpoch);
		return true;
	}

	/// @notice Records that one quote's old-basis accumulated funding was settled before quote mutation begins.
	function consumeFundingSettlementAmount(Quote storage quote, uint256 restatementEpoch) internal {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		require(
			adjustmentLayout.quoteFundingSettledEpoch[quote.id] < restatementEpoch,
			"LibSymbolAdjustmentInventory: Quote funding already settled"
		);
		requirePrepared(quote.symbolId, quote.partyB, restatementEpoch);

		uint256 amount = quote.quantity - quote.closedAmount;
		RestatementInventoryTotals storage fundingTotals = adjustmentLayout.restatementFundingSettlementTotals[quote.symbolId];
		if (quote.positionType == PositionType.LONG) fundingTotals.remainingLong -= amount;
		else fundingTotals.remainingShort -= amount;
		adjustmentLayout.quoteFundingSettledEpoch[quote.id] = restatementEpoch;
	}
}
