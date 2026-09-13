// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Quote, PositionType } from "../storages/QuoteStorage.sol";
import { AggregatedDataStorage, PartiesAggregatedPositions } from "../storages/AggregatedDataStorage.sol";
import { FundingStorage, FundingFee } from "../storages/FundingStorage.sol";
import { LibFundingRate } from "./LibFundingRate.sol";

/// @title LibAggregateFunding
/// @notice Library for managing aggregate funding tracking across positions
/// @dev This library enables O(symbols) funding debt calculation instead of O(quotes)
///      by maintaining aggregate funding state that is updated incrementally
///
/// The key insight is that for quotes sharing the same (partyA, partyB, symbolId, positionType):
///
/// Total Funding = trunc(currentFee × totalOpenAmount / 1e18) - totalWeightedPaidFunding
///
/// By tracking totalWeightedPaidFunding = Σ trunc(openAmount × accumulatedPaidFunding / 1e18), we can
/// calculate total funding debt without iterating through all quotes.
library LibAggregateFunding {
	/// @notice Returns one quote's weighted paid-funding contribution, truncated toward zero.
	function calculateWeightedPaidFunding(uint256 amount, int256 accumulatedPaidFunding) internal pure returns (int256) {
		return (int256(amount) * accumulatedPaidFunding) / 1e18;
	}

	/// @notice Adds to aggregate funding when a position is opened
	/// @dev Called after quote.accumulatedPaidFunding is set in updateAccumulatedPaidFunding.
	///      Updates per-partyB storage since different hedgers have different funding rates.
	/// @param quote The quote being opened
	/// @param amount The amount being opened
	function addToPartyAAggregateFunding(Quote storage quote, uint256 amount) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();

		// Calculate contribution: amount × accumulatedPaidFunding / 1e18
		// Note: accumulatedPaidFunding is already scaled by 1e18
		int256 contribution = calculateWeightedPaidFunding(amount, quote.accumulatedPaidFunding);

		// Update per-partyB storage (required for accurate funding calculations with multiple hedgers)
		aggregatedLayout.partyAAggregatedFundingPerPartyB[quote.partyA][quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding +=
			contribution;
	}

	/// @notice Adds to partyB aggregate funding when a position is opened
	/// @dev Updates both global and per-partyA storage for cross partyB mode support
	/// @param quote The quote being opened
	/// @param amount The amount being opened
	function addToPartyBAggregateFunding(Quote storage quote, uint256 amount) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();

		int256 contribution = calculateWeightedPaidFunding(amount, quote.accumulatedPaidFunding);

		// Update global partyB funding (for cross partyB mode)
		aggregatedLayout.partyBAggregatedFunding[quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding += contribution;

		// Update per-partyA funding
		aggregatedLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding +=
			contribution;
	}

	/// @notice Adds to both parties' aggregate funding when a position is opened
	/// @param quote The quote being opened
	/// @param amount The amount being opened
	function addToPartiesAggregateFunding(Quote storage quote, uint256 amount) internal {
		addToPartyAAggregateFunding(quote, amount);
		addToPartyBAggregateFunding(quote, amount);
	}

	/// @notice Subtracts from both parties' aggregate funding when a position is closed
	/// @param quote The quote being closed
	/// @param oldOpenAmount The quote's open amount before the close
	/// @param newOpenAmount The quote's open amount after the close
	function subFromPartiesAggregateFunding(Quote storage quote, uint256 oldOpenAmount, uint256 newOpenAmount) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		int256 oldContribution = calculateWeightedPaidFunding(oldOpenAmount, quote.accumulatedPaidFunding);
		int256 newContribution = calculateWeightedPaidFunding(newOpenAmount, quote.accumulatedPaidFunding);
		int256 contributionToRemove = oldContribution - newContribution;

		aggregatedLayout.partyAAggregatedFundingPerPartyB[quote.partyA][quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding -=
			contributionToRemove;
		aggregatedLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding -=
			contributionToRemove;
		aggregatedLayout.partyBAggregatedFunding[quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding -= contributionToRemove;

		// Empty groups have no quote contributions, so their weighted paid funding must be zero.
		if (
			aggregatedLayout.partyAAggregatedPositionsPerPartyB[quote.partyA][quote.partyB][quote.symbolId][quote.positionType].aggregatedAmount == 0
		) {
			aggregatedLayout.partyAAggregatedFundingPerPartyB[quote.partyA][quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding = 0;
			aggregatedLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding = 0;
		}
		if (aggregatedLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][quote.positionType].aggregatedAmount == 0) {
			aggregatedLayout.partyBAggregatedFunding[quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding = 0;
		}
	}

	/// @notice Updates aggregate funding when a quote's accumulatedPaidFunding changes
	/// @dev Called when funding is charged and accumulatedPaidFunding is updated.
	///      Updates per-partyB storage for partyA since different hedgers have different funding rates.
	///      Also updates global partyB storage for cross partyB mode support.
	/// @param quote The quote whose funding was charged
	/// @param oldAccumulatedPaidFunding The previous accumulatedPaidFunding value
	/// @param openAmount The current open amount of the quote
	function updatePartiesAggregateFunding(Quote storage quote, int256 oldAccumulatedPaidFunding, uint256 openAmount) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();

		// Calculate the delta in weighted paid funding
		int256 oldContribution = calculateWeightedPaidFunding(openAmount, oldAccumulatedPaidFunding);
		int256 newContribution = calculateWeightedPaidFunding(openAmount, quote.accumulatedPaidFunding);
		int256 delta = newContribution - oldContribution;

		// Update partyA aggregate (per-partyB storage for accurate multi-hedger calculations)
		aggregatedLayout.partyAAggregatedFundingPerPartyB[quote.partyA][quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding +=
			delta;

		// Update global partyB funding (for cross partyB mode)
		aggregatedLayout.partyBAggregatedFunding[quote.partyB][quote.symbolId][quote.positionType].weightedPaidFunding += delta;

		// Update partyB aggregate per partyA
		aggregatedLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding +=
			delta;
	}

	/// @notice Calculates the aggregate funding debt for partyA for a specific symbol and position type
	/// @dev This is a conservative estimate that ignores maxFundingRate caps.
	///      Uses per-partyB storage to correctly handle multi-hedger scenarios.
	/// @param partyA The partyA address
	/// @param partyB The partyB address (needed for funding rate lookup and per-hedger positions)
	/// @param symbolId The symbol ID
	/// @param positionType The position type (LONG or SHORT)
	/// @return The aggregate funding debt (positive = partyA owes, negative = partyA is owed)
	function getPartyAAggregateFundingDebt(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) internal view returns (int256) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		// Use per-partyB positions to get only positions with this specific hedger
		PartiesAggregatedPositions storage pos = aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][positionType];

		if (pos.aggregatedAmount == 0) return 0;

		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0) return 0;

		// Get current accumulated fee (same logic as in getAccumulatedFundingFee)
		int256 currentFee = _calculateCurrentFee(fundingFee, positionType);

		// Use per-partyB weighted paid funding
		int256 weightedPaid = aggregatedLayout.partyAAggregatedFundingPerPartyB[partyA][partyB][symbolId][positionType].weightedPaidFunding;

		// Total funding = totalAmount × currentFee / 1e18 - totalWeightedPaid
		// Note: currentFee already includes epochs multiplication from _calculateCurrentFee
		return (int256(pos.aggregatedAmount) * currentFee) / 1e18 - weightedPaid;
	}

	/// @notice Calculates the aggregate funding debt for partyB per partyA for a specific symbol and position type
	/// @dev PartyB's funding is opposite to partyA's funding
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param symbolId The symbol ID
	/// @param positionType The position type (LONG or SHORT)
	/// @return The aggregate funding debt (positive = partyB owes, negative = partyB is owed)
	function getPartyBAggregateFundingDebt(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) internal view returns (int256) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		PartiesAggregatedPositions storage pos = aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][positionType];

		if (pos.aggregatedAmount == 0) return 0;

		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0) return 0;

		int256 currentFee = _calculateCurrentFee(fundingFee, positionType);

		int256 weightedPaid = aggregatedLayout.partyBAggregatedFundingPerPartyA[partyB][partyA][symbolId][positionType].weightedPaidFunding;

		// PartyB's funding is opposite to partyA's
		int256 partyADebt = (int256(pos.aggregatedAmount) * currentFee) / 1e18 - weightedPaid;
		return -partyADebt;
	}

	/// @notice Calculates the global aggregate funding debt for partyB for a specific symbol and position type
	/// @dev This is for cross partyB mode UPNL calculations across all partyAs.
	///      Uses global partyB positions and global partyB funding storage.
	/// @param partyB The partyB address
	/// @param symbolId The symbol ID
	/// @param positionType The position type (LONG or SHORT)
	/// @return The global aggregate funding debt (positive = partyB owes, negative = partyB is owed)
	function getPartyBGlobalAggregateFundingDebt(address partyB, uint256 symbolId, PositionType positionType) internal view returns (int256) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		// Use global partyB positions (aggregated across all partyAs)
		PartiesAggregatedPositions storage pos = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][positionType];

		if (pos.aggregatedAmount == 0) return 0;

		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0) return 0;

		int256 currentFee = _calculateCurrentFee(fundingFee, positionType);

		// Use global partyB weighted paid funding
		int256 weightedPaid = aggregatedLayout.partyBAggregatedFunding[partyB][symbolId][positionType].weightedPaidFunding;

		// PartyB's funding is opposite to partyA's
		int256 partyADebt = (int256(pos.aggregatedAmount) * currentFee) / 1e18 - weightedPaid;
		return -partyADebt;
	}

	/// @notice Internal function to calculate the current accumulated funding fee
	/// @param fundingFee The funding fee structure
	/// @param positionType The position type
	/// @return The weighted sum of (accumulatedRate * epochsBeforeLastUpdate) + (currentRate * epochsSinceLastUpdate)
	function _calculateCurrentFee(FundingFee storage fundingFee, PositionType positionType) internal view returns (int256) {
		uint256 epochsSinceLastUpdate = LibFundingRate.getEpochsSinceLastUpdate(fundingFee);
		uint256 epochsBeforeLastUpdate = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch;

		int256 accumulatedRate = positionType == PositionType.LONG ? fundingFee.accumulatedLongRate : fundingFee.accumulatedShortRate;
		int256 currentRate = positionType == PositionType.LONG ? fundingFee.currentLongRate : fundingFee.currentShortRate;
		int256 snapshot = positionType == PositionType.LONG ? fundingFee.snapshotLongFee : fundingFee.snapshotShortFee;

		// Calculate current fee = snapshot + weighted average rate × total epochs
		return snapshot + (accumulatedRate * int256(epochsBeforeLastUpdate)) + (currentRate * int256(epochsSinceLastUpdate));
	}
}
