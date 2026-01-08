// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, PositionType, PartiesAggregatedPositions, PartiesAggregatedFunding } from "../storages/QuoteStorage.sol";
import { SymbolStorage, FundingFee } from "../storages/SymbolStorage.sol";
import { LibFundingRate } from "./LibFundingRate.sol";

/**
 * @title LibAggregateFunding
 * @notice Library for managing aggregate funding tracking across positions
 * @dev This library enables O(symbols) funding debt calculation instead of O(quotes)
 *      by maintaining aggregate funding state that is updated incrementally
 *
 * The key insight is that for quotes sharing the same (partyA, partyB, symbolId, positionType):
 *
 * Total Funding = Σ [openAmount_i × (currentFee - accumulatedPaidFunding_i)] / 1e18
 *               = currentFee × Σ(openAmount_i) / 1e18 - Σ(openAmount_i × accumulatedPaidFunding_i) / 1e18
 *               = currentFee × totalOpenAmount / 1e18 - totalWeightedPaidFunding / 1e18
 *
 * By tracking totalWeightedPaidFunding = Σ(openAmount × accumulatedPaidFunding), we can
 * calculate total funding debt without iterating through all quotes.
 *
 * Note: This calculation ignores maxFundingRate caps per quote, resulting in a conservative
 * (higher) funding estimate. This is acceptable for solvency checks.
 */
library LibAggregateFunding {
	/**
	 * @notice Adds to aggregate funding when a position is opened
	 * @dev Called after quote.accumulatedPaidFunding is set in updateAccumulatedPaidFunding
	 * @param quote The quote being opened
	 * @param amount The amount being opened
	 */
	function addToPartyAAggregateFunding(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Calculate contribution: amount × accumulatedPaidFunding / 1e18
		// Note: accumulatedPaidFunding is already scaled by 1e18
		int256 contribution = (int256(amount) * quote.accumulatedPaidFunding) / 1e18;

		quoteLayout.partyAAggregatedFunding[quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding += contribution;
	}

	/**
	 * @notice Adds to partyB aggregate funding per partyA when a position is opened
	 * @param quote The quote being opened
	 * @param amount The amount being opened
	 */
	function addToPartyBAggregateFunding(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		int256 contribution = (int256(amount) * quote.accumulatedPaidFunding) / 1e18;

		quoteLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding += contribution;
	}

	/**
	 * @notice Adds to both parties' aggregate funding when a position is opened
	 * @param quote The quote being opened
	 * @param amount The amount being opened
	 */
	function addToPartiesAggregateFunding(Quote storage quote, uint256 amount) internal {
		addToPartyAAggregateFunding(quote, amount);
		addToPartyBAggregateFunding(quote, amount);
	}

	/**
	 * @notice Subtracts from partyA aggregate funding when a position is closed
	 * @dev Uses the quote's current accumulatedPaidFunding to calculate contribution
	 * @param quote The quote being closed
	 * @param amount The amount being closed
	 */
	function subFromPartyAAggregateFunding(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Calculate contribution to remove: amount × accumulatedPaidFunding / 1e18
		int256 contribution = (int256(amount) * quote.accumulatedPaidFunding) / 1e18;

		quoteLayout.partyAAggregatedFunding[quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding -= contribution;
	}

	/**
	 * @notice Subtracts from partyB aggregate funding per partyA when a position is closed
	 * @param quote The quote being closed
	 * @param amount The amount being closed
	 */
	function subFromPartyBAggregateFunding(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		int256 contribution = (int256(amount) * quote.accumulatedPaidFunding) / 1e18;

		quoteLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding -= contribution;
	}

	/**
	 * @notice Subtracts from both parties' aggregate funding when a position is closed
	 * @param quote The quote being closed
	 * @param amount The amount being closed
	 */
	function subFromPartiesAggregateFunding(Quote storage quote, uint256 amount) internal {
		subFromPartyAAggregateFunding(quote, amount);
		subFromPartyBAggregateFunding(quote, amount);
	}

	/**
	 * @notice Updates aggregate funding when a quote's accumulatedPaidFunding changes
	 * @dev Called when funding is charged and accumulatedPaidFunding is updated
	 * @param quote The quote whose funding was charged
	 * @param oldAccumulatedPaidFunding The previous accumulatedPaidFunding value
	 * @param openAmount The current open amount of the quote
	 */
	function updatePartiesAggregateFunding(Quote storage quote, int256 oldAccumulatedPaidFunding, uint256 openAmount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Calculate the delta in weighted paid funding
		int256 oldContribution = (int256(openAmount) * oldAccumulatedPaidFunding) / 1e18;
		int256 newContribution = (int256(openAmount) * quote.accumulatedPaidFunding) / 1e18;
		int256 delta = newContribution - oldContribution;

		// Update partyA aggregate
		quoteLayout.partyAAggregatedFunding[quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding += delta;

		// Update partyB aggregate per partyA
		quoteLayout.partyBAggregatedFundingPerPartyA[quote.partyB][quote.partyA][quote.symbolId][quote.positionType].weightedPaidFunding += delta;
	}

	/**
	 * @notice Calculates the aggregate funding debt for partyA for a specific symbol and position type
	 * @dev This is a conservative estimate that ignores maxFundingRate caps
	 * @param partyA The partyA address
	 * @param partyB The partyB address (needed for funding rate lookup)
	 * @param symbolId The symbol ID
	 * @param positionType The position type (LONG or SHORT)
	 * @return The aggregate funding debt (positive = partyA owes, negative = partyA is owed)
	 */
	function getPartyAAggregateFundingDebt(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) internal view returns (int256) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartiesAggregatedPositions storage pos = quoteLayout.partyAAggregatedPositions[partyA][symbolId][positionType];

		if (pos.aggregatedAmount == 0) return 0;

		FundingFee storage fundingFee = SymbolStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0) return 0;

		// Get current accumulated fee (same logic as in getAccumulatedFundingFee)
		int256 currentFee = _calculateCurrentFee(fundingFee, positionType);

		int256 weightedPaid = quoteLayout.partyAAggregatedFunding[partyA][symbolId][positionType].weightedPaidFunding;

		// Total funding = totalAmount × currentFee / 1e18 - totalWeightedPaid
		// Note: currentFee already includes epochs multiplication from _calculateCurrentFee
		return (int256(pos.aggregatedAmount) * currentFee) / 1e18 - weightedPaid;
	}

	/**
	 * @notice Calculates the aggregate funding debt for partyB per partyA for a specific symbol and position type
	 * @dev PartyB's funding is opposite to partyA's funding
	 * @param partyB The partyB address
	 * @param partyA The partyA address
	 * @param symbolId The symbol ID
	 * @param positionType The position type (LONG or SHORT)
	 * @return The aggregate funding debt (positive = partyB owes, negative = partyB is owed)
	 */
	function getPartyBAggregateFundingDebt(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) internal view returns (int256) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartiesAggregatedPositions storage pos = quoteLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][positionType];

		if (pos.aggregatedAmount == 0) return 0;

		FundingFee storage fundingFee = SymbolStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0) return 0;

		int256 currentFee = _calculateCurrentFee(fundingFee, positionType);

		int256 weightedPaid = quoteLayout.partyBAggregatedFundingPerPartyA[partyB][partyA][symbolId][positionType].weightedPaidFunding;

		// PartyB's funding is opposite to partyA's
		int256 partyADebt = (int256(pos.aggregatedAmount) * currentFee) / 1e18 - weightedPaid;
		return -partyADebt;
	}

	/**
	 * @notice Internal function to calculate the current accumulated funding fee
	 * @param fundingFee The funding fee structure
	 * @param positionType The position type
	 * @return The current accumulated fee multiplied by epochs since start
	 */
	function _calculateCurrentFee(FundingFee storage fundingFee, PositionType positionType) internal view returns (int256) {
		uint256 epochsSinceLastUpdate = LibFundingRate.getEpochsSinceLastUpdate(fundingFee);
		uint256 epochsBeforeLastUpdate = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch;

		int256 accumulatedRate = positionType == PositionType.LONG ? fundingFee.accumulatedLongRate : fundingFee.accumulatedShortRate;
		int256 currentRate = positionType == PositionType.LONG ? fundingFee.currentLongRate : fundingFee.currentShortRate;

		// Calculate current fee = weighted average rate × total epochs
		return (accumulatedRate * int256(epochsBeforeLastUpdate)) + (currentRate * int256(epochsSinceLastUpdate));
	}
}
