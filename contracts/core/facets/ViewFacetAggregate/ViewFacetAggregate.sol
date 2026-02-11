// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PositionType } from "../../storages/QuoteStorage.sol";
import { AggregatedDataStorage, PartiesAggregatedPositions, PartiesAggregatedFunding } from "../../storages/AggregatedDataStorage.sol";
import { IViewFacetAggregate } from "./IViewFacetAggregate.sol";
import { LibAggregateFunding } from "../../libraries/LibAggregateFunding.sol";

/// @title ViewFacetAggregate
/// @notice View functions for aggregate position and funding data
/// @dev Enables O(symbols) UPNL calculations instead of O(quotes) by exposing pre-aggregated state
contract ViewFacetAggregate is IViewFacetAggregate {
	// ============ Position Aggregate View Functions ============

	/// @notice Returns Aggregated open position amounts and average open prices for a party B and symbol (global across all partyAs).
	/// @param partyB The address of party B.
	/// @param symbolId The symbol ID.
	/// @return longPosition Aggregated open amount and avg open price for LONG positions.
	/// @return shortPosition Aggregated open amount and avg open price for SHORT positions.
	function getPartyBAggregatedPositionBySymbol(
		address partyB,
		uint256 symbolId
	) external view returns (AggregatedPositionAmount memory longPosition, AggregatedPositionAmount memory shortPosition) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		mapping(PositionType => PartiesAggregatedPositions) storage aggregatedPositions = aggregatedLayout.partyBAggregatedPositions[partyB][
			symbolId
		];
		uint256 longAmount = aggregatedPositions[PositionType.LONG].aggregatedAmount;
		uint256 shortAmount = aggregatedPositions[PositionType.SHORT].aggregatedAmount;
		uint256 longNotional = aggregatedPositions[PositionType.LONG].aggregatedNotional;
		uint256 shortNotional = aggregatedPositions[PositionType.SHORT].aggregatedNotional;
		longPosition = AggregatedPositionAmount(PositionType.LONG, longAmount, longAmount == 0 ? 0 : longNotional / longAmount);
		shortPosition = AggregatedPositionAmount(PositionType.SHORT, shortAmount, shortAmount == 0 ? 0 : shortNotional / shortAmount);
	}

	/// @notice Returns Aggregated open position amounts and average open prices for a party B, party A, and symbol, grouped by position type.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @param symbolId The symbol ID.
	/// @return longPosition Aggregated open amount and avg open price for LONG positions.
	/// @return shortPosition Aggregated open amount and avg open price for SHORT positions.
	function getPartyBAggregatedPositionBySymbolPerPartyA(
		address partyB,
		address partyA,
		uint256 symbolId
	) external view returns (AggregatedPositionAmount memory longPosition, AggregatedPositionAmount memory shortPosition) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		mapping(PositionType => PartiesAggregatedPositions) storage aggregatedPositions = aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][
			partyA
		][symbolId];
		uint256 longAmount = aggregatedPositions[PositionType.LONG].aggregatedAmount;
		uint256 shortAmount = aggregatedPositions[PositionType.SHORT].aggregatedAmount;
		uint256 longNotional = aggregatedPositions[PositionType.LONG].aggregatedNotional;
		uint256 shortNotional = aggregatedPositions[PositionType.SHORT].aggregatedNotional;
		longPosition = AggregatedPositionAmount(PositionType.LONG, longAmount, longAmount == 0 ? 0 : longNotional / longAmount);
		shortPosition = AggregatedPositionAmount(PositionType.SHORT, shortAmount, shortAmount == 0 ? 0 : shortNotional / shortAmount);
	}

	/// @notice Returns Aggregated open position amounts and average open prices for a party A, party B, and symbol, grouped by position type.
	/// @param partyA The address of party A.
	/// @param partyB The address of party B.
	/// @param symbolId The symbol ID.
	/// @return longPosition Aggregated open amount and avg open price for LONG positions.
	/// @return shortPosition Aggregated open amount and avg open price for SHORT positions.
	function getPartyAAggregatedPositionBySymbolPerPartyB(
		address partyA,
		address partyB,
		uint256 symbolId
	) external view returns (AggregatedPositionAmount memory longPosition, AggregatedPositionAmount memory shortPosition) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		mapping(PositionType => PartiesAggregatedPositions) storage aggregatedPositions = aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][
			partyB
		][symbolId];
		uint256 longAmount = aggregatedPositions[PositionType.LONG].aggregatedAmount;
		uint256 shortAmount = aggregatedPositions[PositionType.SHORT].aggregatedAmount;
		uint256 longNotional = aggregatedPositions[PositionType.LONG].aggregatedNotional;
		uint256 shortNotional = aggregatedPositions[PositionType.SHORT].aggregatedNotional;
		longPosition = AggregatedPositionAmount(PositionType.LONG, longAmount, longAmount == 0 ? 0 : longNotional / longAmount);
		shortPosition = AggregatedPositionAmount(PositionType.SHORT, shortAmount, shortAmount == 0 ? 0 : shortNotional / shortAmount);
	}

	// ============ Funding Aggregate View Functions ============

	/// @notice Returns the aggregate funding state for partyA per partyB at a specific symbol and position type
	/// @dev Uses per-partyB storage to correctly handle multi-hedger scenarios
	/// @param partyA The partyA address
	/// @param partyB The partyB address (different hedgers have different funding rates)
	/// @param symbolId The symbol ID
	/// @param positionType The position type (0 = LONG, 1 = SHORT)
	/// @return weightedPaidFunding The weighted paid funding: Σ(openAmount × accumulatedPaidFunding / 1e18)
	function getPartyAAggregatedFundingPerPartyB(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 weightedPaidFunding) {
		return AggregatedDataStorage.layout().partyAAggregatedFundingPerPartyB[partyA][partyB][symbolId][positionType].weightedPaidFunding;
	}

	/// @notice Returns the aggregate funding state for partyB per partyA at a specific symbol and position type
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param symbolId The symbol ID
	/// @param positionType The position type (0 = LONG, 1 = SHORT)
	/// @return weightedPaidFunding The weighted paid funding: Σ(openAmount × accumulatedPaidFunding / 1e18)
	function getPartyBAggregatedFundingPerPartyA(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 weightedPaidFunding) {
		return AggregatedDataStorage.layout().partyBAggregatedFundingPerPartyA[partyB][partyA][symbolId][positionType].weightedPaidFunding;
	}

	/// @notice Returns the global aggregate funding state for partyB at a specific symbol and position type
	/// @dev Used for cross partyB mode UPNL calculations across all partyAs
	/// @param partyB The partyB address
	/// @param symbolId The symbol ID
	/// @param positionType The position type (0 = LONG, 1 = SHORT)
	/// @return weightedPaidFunding The weighted paid funding: Σ(openAmount × accumulatedPaidFunding / 1e18)
	function getPartyBAggregatedFunding(
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 weightedPaidFunding) {
		return AggregatedDataStorage.layout().partyBAggregatedFunding[partyB][symbolId][positionType].weightedPaidFunding;
	}

	/// @notice Returns the calculated aggregate funding debt for partyA at a specific symbol and position type
	/// @dev This is a conservative estimate that ignores maxFundingRate caps
	/// @param partyA The partyA address
	/// @param partyB The partyB address (needed for funding rate lookup)
	/// @param symbolId The symbol ID
	/// @param positionType The position type (0 = LONG, 1 = SHORT)
	/// @return fundingDebt The aggregate funding debt (positive = partyA owes, negative = partyA is owed)
	function getPartyAAggregateFundingDebt(
		address partyA,
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt) {
		return LibAggregateFunding.getPartyAAggregateFundingDebt(partyA, partyB, symbolId, positionType);
	}

	/// @notice Returns the calculated aggregate funding debt for partyB per partyA at a specific symbol and position type
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param symbolId The symbol ID
	/// @param positionType The position type (0 = LONG, 1 = SHORT)
	/// @return fundingDebt The aggregate funding debt (positive = partyB owes, negative = partyB is owed)
	function getPartyBAggregateFundingDebt(
		address partyB,
		address partyA,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt) {
		return LibAggregateFunding.getPartyBAggregateFundingDebt(partyB, partyA, symbolId, positionType);
	}

	/// @notice Returns the global calculated aggregate funding debt for partyB at a specific symbol and position type
	/// @dev This is for cross partyB mode UPNL calculations across all partyAs
	/// @param partyB The partyB address
	/// @param symbolId The symbol ID
	/// @param positionType The position type (0 = LONG, 1 = SHORT)
	/// @return fundingDebt The global aggregate funding debt (positive = partyB owes, negative = partyB is owed)
	function getPartyBGlobalAggregateFundingDebt(
		address partyB,
		uint256 symbolId,
		PositionType positionType
	) external view returns (int256 fundingDebt) {
		return LibAggregateFunding.getPartyBGlobalAggregateFundingDebt(partyB, symbolId, positionType);
	}

	// ============ Active Symbols View Functions ============

	/// @notice Returns the count of active symbols for partyB (global across all partyAs)
	/// @param partyB The partyB address
	/// @return The number of active symbols
	function getPartyBActiveSymbolsCount(address partyB) external view returns (uint256) {
		return AggregatedDataStorage.layout().partyBActiveSymbols[partyB].length;
	}

	/// @notice Returns a paginated list of symbol IDs that partyB has active positions in (global)
	/// @param partyB The partyB address
	/// @param start The starting index
	/// @param size The maximum number of symbols to return
	/// @return An array of symbol IDs
	function getPartyBActiveSymbols(address partyB, uint256 start, uint256 size) external view returns (uint256[] memory) {
		uint256[] storage activeSymbols = AggregatedDataStorage.layout().partyBActiveSymbols[partyB];
		uint256 totalLength = activeSymbols.length;
		if (totalLength <= start) return new uint256[](0);
		if (start + size > totalLength) size = totalLength - start;

		uint256[] memory result = new uint256[](size);
		for (uint256 i = 0; i < size; ) {
			result[i] = activeSymbols[start + i];
			unchecked {
				++i;
			}
		}
		return result;
	}

	/// @notice Returns the count of active symbols for partyB with specific partyA
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @return The number of active symbols
	function getPartyBActiveSymbolsCountPerPartyA(address partyB, address partyA) external view returns (uint256) {
		return AggregatedDataStorage.layout().partyBActiveSymbolsPerPartyA[partyB][partyA].length;
	}

	/// @notice Returns the count of active symbols for partyA with specific partyB
	/// @dev Symbols where partyA has positions with this specific hedger
	/// @param partyA The partyA address
	/// @param partyB The partyB address
	/// @return The number of active symbols with this hedger
	function getPartyAActiveSymbolsCountPerPartyB(address partyA, address partyB) external view returns (uint256) {
		return AggregatedDataStorage.layout().partyAActiveSymbolsPerPartyB[partyA][partyB].length;
	}

	/// @notice Returns a paginated list of symbol IDs that partyA has active positions in with specific partyB
	/// @dev Used for iterating through symbols where partyA has positions with a specific hedger
	/// @param partyA The partyA address
	/// @param partyB The partyB address
	/// @param start The starting index
	/// @param size The maximum number of symbols to return
	/// @return An array of symbol IDs
	function getPartyAActiveSymbolsPerPartyB(address partyA, address partyB, uint256 start, uint256 size) external view returns (uint256[] memory) {
		uint256[] storage activeSymbols = AggregatedDataStorage.layout().partyAActiveSymbolsPerPartyB[partyA][partyB];
		uint256 totalLength = activeSymbols.length;
		if (totalLength <= start) return new uint256[](0);
		if (start + size > totalLength) size = totalLength - start;

		uint256[] memory result = new uint256[](size);
		for (uint256 i = 0; i < size; ) {
			result[i] = activeSymbols[start + i];
			unchecked {
				++i;
			}
		}
		return result;
	}

	/// @notice Returns a paginated list of symbol IDs that partyB has active positions in with specific partyA
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param start The starting index
	/// @param size The maximum number of symbols to return
	/// @return An array of symbol IDs
	function getPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 start, uint256 size) external view returns (uint256[] memory) {
		uint256[] storage activeSymbols = AggregatedDataStorage.layout().partyBActiveSymbolsPerPartyA[partyB][partyA];
		uint256 totalLength = activeSymbols.length;
		if (totalLength <= start) return new uint256[](0);
		if (start + size > totalLength) size = totalLength - start;

		uint256[] memory result = new uint256[](size);
		for (uint256 i = 0; i < size; ) {
			result[i] = activeSymbols[start + i];
			unchecked {
				++i;
			}
		}
		return result;
	}

	// ============ Aggregates by Active Symbols View Functions ============

	/// @notice Returns paginated aggregated positions for partyB using active symbols (global)
	/// @param partyB The partyB address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of aggregated positions by symbol
	function getPartyBAggregatedPositionsByActiveSymbols(
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyBActiveSymbols[partyB];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new AggregatedPositionBySymbol[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new AggregatedPositionBySymbol[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			PartiesAggregatedPositions storage longPos = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.LONG];
			if (longPos.aggregatedAmount > 0) {
				results[count++] = AggregatedPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					aggregatedOpenAmount: longPos.aggregatedAmount,
					avgOpenPrice: longPos.aggregatedNotional / longPos.aggregatedAmount
				});
			}

			PartiesAggregatedPositions storage shortPos = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.SHORT];
			if (shortPos.aggregatedAmount > 0) {
				results[count++] = AggregatedPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					aggregatedOpenAmount: shortPos.aggregatedAmount,
					avgOpenPrice: shortPos.aggregatedNotional / shortPos.aggregatedAmount
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated aggregated positions for partyA per partyB using active symbols
	/// @param partyA The partyA address
	/// @param partyB The partyB address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of aggregated positions by symbol
	function getPartyAAggregatedPositionsByActiveSymbolsPerPartyB(
		address partyA,
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new AggregatedPositionBySymbol[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new AggregatedPositionBySymbol[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			PartiesAggregatedPositions storage longPos = aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][
				PositionType.LONG
			];
			if (longPos.aggregatedAmount > 0) {
				results[count++] = AggregatedPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					aggregatedOpenAmount: longPos.aggregatedAmount,
					avgOpenPrice: longPos.aggregatedNotional / longPos.aggregatedAmount
				});
			}

			PartiesAggregatedPositions storage shortPos = aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][
				PositionType.SHORT
			];
			if (shortPos.aggregatedAmount > 0) {
				results[count++] = AggregatedPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					aggregatedOpenAmount: shortPos.aggregatedAmount,
					avgOpenPrice: shortPos.aggregatedNotional / shortPos.aggregatedAmount
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated aggregated positions for partyB per partyA using active symbols
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of aggregated positions by symbol
	function getPartyBAggregatedPositionsByActiveSymbolsPerPartyA(
		address partyB,
		address partyA,
		uint256 start,
		uint256 size
	) external view returns (AggregatedPositionBySymbol[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new AggregatedPositionBySymbol[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new AggregatedPositionBySymbol[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			PartiesAggregatedPositions storage longPos = aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][
				PositionType.LONG
			];
			if (longPos.aggregatedAmount > 0) {
				results[count++] = AggregatedPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					aggregatedOpenAmount: longPos.aggregatedAmount,
					avgOpenPrice: longPos.aggregatedNotional / longPos.aggregatedAmount
				});
			}

			PartiesAggregatedPositions storage shortPos = aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][
				PositionType.SHORT
			];
			if (shortPos.aggregatedAmount > 0) {
				results[count++] = AggregatedPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					aggregatedOpenAmount: shortPos.aggregatedAmount,
					avgOpenPrice: shortPos.aggregatedNotional / shortPos.aggregatedAmount
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated aggregated funding debt for partyA across active symbols
	/// @param partyA The partyA address
	/// @param partyB The partyB address (needed for funding rate lookup)
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of funding debt by symbol and position type
	function getPartyAAggregateFundingDebtByActiveSymbols(
		address partyA,
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new AggregatedFundingDebtBySymbol[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new AggregatedFundingDebtBySymbol[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			if (aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][PositionType.LONG].aggregatedAmount > 0) {
				results[count++] = AggregatedFundingDebtBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					fundingDebt: LibAggregateFunding.getPartyAAggregateFundingDebt(partyA, partyB, symbolId, PositionType.LONG)
				});
			}

			if (aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][PositionType.SHORT].aggregatedAmount > 0) {
				results[count++] = AggregatedFundingDebtBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					fundingDebt: LibAggregateFunding.getPartyAAggregateFundingDebt(partyA, partyB, symbolId, PositionType.SHORT)
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated aggregated funding debt for partyB per partyA across active symbols
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of funding debt by symbol and position type
	function getPartyBAggregateFundingDebtByActiveSymbols(
		address partyB,
		address partyA,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new AggregatedFundingDebtBySymbol[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new AggregatedFundingDebtBySymbol[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			if (aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][PositionType.LONG].aggregatedAmount > 0) {
				results[count++] = AggregatedFundingDebtBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					fundingDebt: LibAggregateFunding.getPartyBAggregateFundingDebt(partyB, partyA, symbolId, PositionType.LONG)
				});
			}

			if (aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][PositionType.SHORT].aggregatedAmount > 0) {
				results[count++] = AggregatedFundingDebtBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					fundingDebt: LibAggregateFunding.getPartyBAggregateFundingDebt(partyB, partyA, symbolId, PositionType.SHORT)
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated global aggregated funding debt for partyB across active symbols
	/// @dev Uses global partyB active symbols - for cross partyB mode UPNL calculations
	/// @param partyB The partyB address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of funding debt by symbol and position type
	function getPartyBGlobalAggregateFundingDebtByActiveSymbols(
		address partyB,
		uint256 start,
		uint256 size
	) external view returns (AggregatedFundingDebtBySymbol[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyBActiveSymbols[partyB];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new AggregatedFundingDebtBySymbol[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new AggregatedFundingDebtBySymbol[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			if (aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.LONG].aggregatedAmount > 0) {
				results[count++] = AggregatedFundingDebtBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					fundingDebt: LibAggregateFunding.getPartyBGlobalAggregateFundingDebt(partyB, symbolId, PositionType.LONG)
				});
			}

			if (aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.SHORT].aggregatedAmount > 0) {
				results[count++] = AggregatedFundingDebtBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					fundingDebt: LibAggregateFunding.getPartyBGlobalAggregateFundingDebt(partyB, symbolId, PositionType.SHORT)
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	// ============ UPNL Data View Functions ============

	/// @notice Returns paginated UPNL data for partyA with a specific partyB
	/// @dev Returns all data needed for off-chain UPNL calculation:
	///      - LONG UPNL: (price - avgOpenPrice) × amount / 1e18 - fundingDebt
	///      - SHORT UPNL: (avgOpenPrice - price) × amount / 1e18 - fundingDebt
	/// @param partyA The partyA address
	/// @param partyB The partyB address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of UPNL data for each symbol/position type
	function getPartyAUpnlData(address partyA, address partyB, uint256 start, uint256 size) external view returns (UpnlData[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new UpnlData[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new UpnlData[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			// LONG position data
			PartiesAggregatedPositions storage longPos = aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][
				PositionType.LONG
			];
			if (longPos.aggregatedAmount > 0) {
				results[count++] = UpnlData({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					aggregatedAmount: longPos.aggregatedAmount,
					avgOpenPrice: longPos.aggregatedNotional / longPos.aggregatedAmount,
					fundingDebt: LibAggregateFunding.getPartyAAggregateFundingDebt(partyA, partyB, symbolId, PositionType.LONG)
				});
			}

			// SHORT position data
			PartiesAggregatedPositions storage shortPos = aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][
				PositionType.SHORT
			];
			if (shortPos.aggregatedAmount > 0) {
				results[count++] = UpnlData({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					aggregatedAmount: shortPos.aggregatedAmount,
					avgOpenPrice: shortPos.aggregatedNotional / shortPos.aggregatedAmount,
					fundingDebt: LibAggregateFunding.getPartyAAggregateFundingDebt(partyA, partyB, symbolId, PositionType.SHORT)
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated UPNL data for partyB with a specific partyA
	/// @dev PartyB's UPNL is opposite to partyA's:
	///      - LONG UPNL: (avgOpenPrice - price) × amount / 1e18 - fundingDebt
	///      - SHORT UPNL: (price - avgOpenPrice) × amount / 1e18 - fundingDebt
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of UPNL data for each symbol/position type
	function getPartyBUpnlData(address partyB, address partyA, uint256 start, uint256 size) external view returns (UpnlData[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new UpnlData[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new UpnlData[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			// LONG position data
			PartiesAggregatedPositions storage longPos = aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][
				PositionType.LONG
			];
			if (longPos.aggregatedAmount > 0) {
				results[count++] = UpnlData({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					aggregatedAmount: longPos.aggregatedAmount,
					avgOpenPrice: longPos.aggregatedNotional / longPos.aggregatedAmount,
					fundingDebt: LibAggregateFunding.getPartyBAggregateFundingDebt(partyB, partyA, symbolId, PositionType.LONG)
				});
			}

			// SHORT position data
			PartiesAggregatedPositions storage shortPos = aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][
				PositionType.SHORT
			];
			if (shortPos.aggregatedAmount > 0) {
				results[count++] = UpnlData({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					aggregatedAmount: shortPos.aggregatedAmount,
					avgOpenPrice: shortPos.aggregatedNotional / shortPos.aggregatedAmount,
					fundingDebt: LibAggregateFunding.getPartyBAggregateFundingDebt(partyB, partyA, symbolId, PositionType.SHORT)
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}

	/// @notice Returns paginated global UPNL data for partyB (cross partyB mode)
	/// @dev Aggregates across all partyAs. PartyB's UPNL is opposite to partyA's:
	///      - LONG UPNL: (avgOpenPrice - price) × amount / 1e18 - fundingDebt
	///      - SHORT UPNL: (price - avgOpenPrice) × amount / 1e18 - fundingDebt
	/// @param partyB The partyB address
	/// @param start The starting index in the active symbols array
	/// @param size The maximum number of symbols to process
	/// @return results Array of UPNL data for each symbol/position type
	function getPartyBGlobalUpnlData(address partyB, uint256 start, uint256 size) external view returns (UpnlData[] memory results) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256[] storage activeSymbols = aggregatedLayout.partyBActiveSymbols[partyB];
		uint256 totalLength = activeSymbols.length;

		if (totalLength <= start || size == 0) return new UpnlData[](0);
		if (start + size > totalLength) size = totalLength - start;

		results = new UpnlData[](size * 2);
		uint256 count;
		uint256 end = start + size;

		for (uint256 i = start; i < end; ) {
			uint256 symbolId = activeSymbols[i];

			// LONG position data
			PartiesAggregatedPositions storage longPos = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.LONG];
			if (longPos.aggregatedAmount > 0) {
				results[count++] = UpnlData({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					aggregatedAmount: longPos.aggregatedAmount,
					avgOpenPrice: longPos.aggregatedNotional / longPos.aggregatedAmount,
					fundingDebt: LibAggregateFunding.getPartyBGlobalAggregateFundingDebt(partyB, symbolId, PositionType.LONG)
				});
			}

			// SHORT position data
			PartiesAggregatedPositions storage shortPos = aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.SHORT];
			if (shortPos.aggregatedAmount > 0) {
				results[count++] = UpnlData({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					aggregatedAmount: shortPos.aggregatedAmount,
					avgOpenPrice: shortPos.aggregatedNotional / shortPos.aggregatedAmount,
					fundingDebt: LibAggregateFunding.getPartyBGlobalAggregateFundingDebt(partyB, symbolId, PositionType.SHORT)
				});
			}

			unchecked {
				++i;
			}
		}

		assembly {
			mstore(results, count)
		}
	}
}
