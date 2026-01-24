// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PositionType } from "../../storages/QuoteStorage.sol";

/**
 * @title IViewFacetAggregate
 * @notice Interface for aggregate position and funding view functions
 * @dev Used for efficient UPNL calculations with O(symbols) complexity instead of O(quotes)
 */
interface IViewFacetAggregate {
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

	// ============ Position Aggregate View Functions ============

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

	// ============ Funding Aggregate View Functions ============

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

	function getPartyBAggregatedFunding(
		address partyB,
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

	function getPartyBGlobalAggregateFundingDebt(
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt);

	// ============ Active Symbols View Functions ============

	function getPartyBActiveSymbolsCount(address partyB) external view returns (uint256);

	function getPartyBActiveSymbols(address partyB, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getPartyBActiveSymbolsCountPerPartyA(address partyB, address partyA) external view returns (uint256);

	function getPartyAActiveSymbolsCountPerPartyB(address partyA, address partyB) external view returns (uint256);

	function getPartyAActiveSymbolsPerPartyB(address partyA, address partyB, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 start, uint256 size) external view returns (uint256[] memory);

	// ============ Aggregates by Active Symbols View Functions ============

	function getPartyBAggregatedPositionsByActiveSymbols(
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory);

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

	function getPartyBGlobalAggregateFundingDebtByActiveSymbols(
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory);
}
