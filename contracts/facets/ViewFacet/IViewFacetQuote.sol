// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Quote, PositionType } from "../../storages/QuoteStorage.sol";

interface IViewFacetQuote {
	struct AggregatedPositionAmount {
		PositionType positionType;
		uint256 aggregatedOpenAmount;
		uint256 avgOpenPrice;
	}

	struct AggregatedPositionBySymbol {
		uint256 symbolId;
		PositionType positionType;
		uint256 aggregatedOpenAmount;
		uint256 avgOpenPrice;
	}

	struct AggregatedFundingDebtBySymbol {
		uint256 symbolId;
		PositionType positionType;
		int256 fundingDebt;
	}

	struct Bitmap {
		uint256 size;
		BitmapElement[] elements;
	}

	struct BitmapElement {
		uint256 offset;
		uint256 bitmap;
	}

	function getQuote(uint256 quoteId) external view returns (Quote memory);

	function getQuotesByParent(uint256 quoteId, uint256 size) external view returns (Quote[] memory);

	function quoteIdsOf(address partyA, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getQuotes(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	function quotesLength(address user) external view returns (uint256);

	function partyAPositionsCount(address partyA) external view returns (uint256);

	function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getPartyBOpenPositions(address partyB, address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getOpenPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getActivePositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory);

	function partyBPositionsCount(address partyB, address partyA) external view returns (uint256);

	function getPartyBAggregatedPositionBySymbol(
		address partyB,
		uint256 symbolId
	) external view returns (AggregatedPositionAmount memory longPosition, AggregatedPositionAmount memory shortPosition);

	function getPartyBAggregatedPositionBySymbolPerPartyA(
		address partyB,
		address partyA,
		uint256 symbolId
	) external view returns (AggregatedPositionAmount memory longPosition, AggregatedPositionAmount memory shortPosition);

	function getPartyAAggregatedPositionBySymbolPerPartyB(
		address partyA,
		address partyB,
		uint256 symbolId
	) external view returns (AggregatedPositionAmount memory longPosition, AggregatedPositionAmount memory shortPosition);

	function getPartyAPendingQuotes(address partyA) external view returns (uint256[] memory);

	function getPartyBPendingQuotes(address partyB, address partyA) external view returns (uint256[] memory);

	function getQuotesWithBitmap(Bitmap calldata bitmap, uint256 gasNeededForReturn) external view returns (Quote[] memory quotes);

	function getNextQuoteId() external view returns (uint256);

	function getQuoteCloseId(uint256 quoteId) external view returns (uint256);

	function getQuoteFundingDebts(uint256[] memory quoteIds) external view returns (int256[] memory debts);

	function getSumQuoteFundingDebts(uint256[] memory quoteIds) external view returns (int256 sum);

	function getPartyAUPNLParams(
		address partyA,
		uint256 quoteStart,
		uint256 quoteEnd,
		bool getCount
	)
		external
		view
		returns (
			uint256 positionsCount,
			uint256[] memory partyBsAllocated,
			address[] memory partyBs,
			uint256[] memory quoteIds,
			uint256[] memory symbolIds,
			string[] memory symbolNames,
			uint256[] memory openPrices,
			uint256[] memory remainingOpenAmount,
			uint256[] memory positionType
		);

	function getPartyBUPNLParams(
		address partyA,
		address partyB,
		uint256 quoteStart,
		uint256 quoteEnd,
		bool getCount
	)
		external
		view
		returns (
			uint256 positionsCount,
			uint256[] memory partyBsAllocated,
			uint256[] memory quoteIds,
			uint256[] memory symbolIds,
			string[] memory symbolNames,
			uint256[] memory openPrices,
			uint256[] memory remainingOpenAmount,
			uint256[] memory positionType
		);

	// ============ Aggregate Funding View Functions ============

	function getPartyAAggregatedFundingPerPartyB(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 weightedPaidFunding);

	function getPartyBAggregatedFundingPerPartyA(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 weightedPaidFunding);

	function getPartyAAggregateFundingDebt(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt);

	function getPartyBAggregateFundingDebt(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt);

	function getPartyACompleteAggregateStatePerPartyB(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (uint256 aggregatedAmount, uint256 aggregatedNotional, int256 weightedPaidFunding);

	function getPartyBCompleteAggregateStatePerPartyA(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) external view returns (uint256 aggregatedAmount, uint256 aggregatedNotional, int256 weightedPaidFunding);

	// ============ Active Symbols View Functions ============

	function getPartyBActiveSymbolsCount(address partyB) external view returns (uint256);

	function getPartyBActiveSymbols(address partyB, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getPartyBAggregatedPositionsByActiveSymbols(
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory);

	function getPartyBActiveSymbolsCountPerPartyA(address partyB, address partyA) external view returns (uint256);

	function getPartyAActiveSymbolsCountPerPartyB(address partyA, address partyB) external view returns (uint256);

	function getPartyAActiveSymbolsPerPartyB(address partyA, address partyB, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(
		address partyA,
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory);

	function getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(
		address partyB,
		address partyA,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory);

	function getPartyAAggregateFundingDebtByActiveSymbols(
		address partyA,
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory);

	function getPartyBAggregateFundingDebtByActiveSymbols(
		address partyB,
		address partyA,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory);

	// ============ Global PartyB Funding View Functions ============

	function getPartyBAggregatedFunding(
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 weightedPaidFunding);

	function getPartyBGlobalAggregateFundingDebt(
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt);

	function getPartyBGlobalAggregateFundingDebtByActiveSymbols(
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory);
}
