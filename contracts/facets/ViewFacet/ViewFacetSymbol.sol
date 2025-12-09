// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../libraries/LibQuoteFunding.sol";
import "../../libraries/LibConnections.sol";
import "../../storages/AccountStorage.sol";
import "../../storages/QuoteStorage.sol";
import "../../storages/SymbolStorage.sol";
import "./IViewFacetSymbol.sol";

contract ViewFacetSymbol is IViewFacetSymbol {
	/**
	 * @notice Returns the details of a symbol by its ID.
	 * @param symbolId The ID of the symbol.
	 * @return The details of the symbol.
	 */
	function getSymbol(uint256 symbolId) external view returns (Symbol memory) {
		return SymbolStorage.layout().symbols[symbolId];
	}

	/**
	 * @notice Converts a symbol to a symbol with type.
	 * @param symbol The symbol to convert.
	 * @param symbolType The type of the symbol.
	 * @return The symbol with type.
	 */
	function _toSymbolWithType(Symbol memory symbol, uint256 symbolType) internal pure returns (SymbolWithType memory) {
		return
			SymbolWithType(
				symbol.symbolId,
				symbol.name,
				symbol.isValid,
				symbol.minAcceptableQuoteValue,
				symbol.minAcceptablePortionLF,
				symbol.tradingFee,
				symbol.maxLeverage,
				symbol.fundingRateEpochDuration,
				symbol.fundingRateWindowTime,
				symbolType
			);
	}

	/**
	 * @notice Returns the details of a symbol along with its type.
	 * @param symbolId The ID of the symbol to retrieve.
	 * @return A SymbolWithType struct containing the symbol details and its type.
	 */
	function getSymbolWithType(uint256 symbolId) external view returns (SymbolWithType memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		Symbol memory symbol = symbolLayout.symbols[symbolId];

		return _toSymbolWithType(symbol, symbolLayout.symbolTypes[symbolId]);
	}

	/**
	 * @notice Returns an array of symbols starting from a specific index.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of symbols.
	 */
	function getSymbols(uint256 start, uint256 size) external view returns (Symbol[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();

		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}

		Symbol[] memory symbols = new Symbol[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			symbols[i - start] = symbolLayout.symbols[i + 1];
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/**
	 * @notice Returns an array of symbols with their types starting from a specific index.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of symbols with their types.
	 */
	function getSymbolsWithType(uint256 start, uint256 size) external view returns (SymbolWithType[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}
		SymbolWithType[] memory symbols = new SymbolWithType[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			Symbol memory symbol = symbolLayout.symbols[i + 1];
			symbols[i - start] = _toSymbolWithType(symbol, symbolLayout.symbolTypes[symbol.symbolId]);
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/**
	 * @notice Returns the connected party Bs of Party A.
	 * @param partyA The address of Party A.
	 * @return An array of connected party Bs.
	 */
	function getConnectedPartyBs(address partyA) external view returns (address[] memory) {
		return AccountStorage.layout().connectedPartyBs[partyA];
	}

	/**
	 * @notice Returns the connected party Bs of Party A.
	 * @param partyA The address of Party A.
	 * @return An array of connected party Bs.
	 */
	function isConnectedPartyB(address partyA, address partyB) external view returns (bool) {
		return AccountStorage.layout().isConnectedPartyB[partyA][partyB];
	}

	/**
	 * @notice Returns the allowed symbols of Party A.
	 * @param partyA The address of Party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of allowed symbols.
	 */
	function getAllowedSymbolsForPartyA(address partyA, uint256 start, uint256 size) external view returns (Symbol[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}
		Symbol[] memory symbols = new Symbol[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			Symbol memory symbol = symbolLayout.symbols[i + 1];
			if (LibConnections.isSymbolAllowedForPartyA(partyA, symbol.symbolId) && symbol.isValid) {
				symbols[i - start] = symbol;
			}
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/**
	 * @notice Returns an array of symbols with their types associated with a party A.
	 * @param partyA The address of Party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of symbols with their types.
	 */
	function getAllowedSymbolsWithTypeForPartyA(address partyA, uint256 start, uint256 size) external view returns (SymbolWithType[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}
		SymbolWithType[] memory symbols = new SymbolWithType[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			Symbol memory symbol = symbolLayout.symbols[i + 1];
			if (LibConnections.isSymbolAllowedForPartyA(partyA, symbol.symbolId) && symbol.isValid) {
				symbols[i - start] = _toSymbolWithType(symbol, symbolLayout.symbolTypes[symbol.symbolId]);
			}
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/**
	 * @notice Returns an array of symbols associated with an array of quote IDs.
	 * @param quoteIds An array of quote IDs.
	 * @return An array of symbols.
	 */
	function symbolsByQuoteId(uint256[] memory quoteIds) external view returns (Symbol[] memory) {
		Symbol[] memory symbols = new Symbol[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			symbols[i] = SymbolStorage.layout().symbols[QuoteStorage.layout().quotes[quoteIds[i]].symbolId];
		}
		return symbols;
	}

	/**
	 * @notice Returns an array of symbol names associated with an array of quote IDs.
	 * @param quoteIds An array of quote IDs.
	 * @return An array of symbol names.
	 */
	function symbolNameByQuoteId(uint256[] memory quoteIds) external view returns (string[] memory) {
		string[] memory symbols = new string[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			symbols[i] = SymbolStorage.layout().symbols[QuoteStorage.layout().quotes[quoteIds[i]].symbolId].name;
		}
		return symbols;
	}

	/**
	 * @notice Returns an array of symbol names associated with an array of symbol IDs.
	 * @param symbolIds An array of symbol IDs.
	 * @return An array of symbol names.
	 */
	function symbolNameById(uint256[] memory symbolIds) external view returns (string[] memory) {
		string[] memory symbols = new string[](symbolIds.length);
		for (uint256 i = 0; i < symbolIds.length; i++) {
			symbols[i] = SymbolStorage.layout().symbols[symbolIds[i]].name;
		}
		return symbols;
	}

	/**
	 * @notice Checks if a symbol type is whitelisted for a party B.
	 * @param partyB The address of party B.
	 * @param symbolType The type of the symbol.
	 * @return A boolean indicating whether the symbol type is whitelisted for the party B.
	 */
	function isWhitelistedSymbolType(address partyB, uint256 symbolType) external view returns (bool) {
		return AccountStorage.layout().partyBWhitelistedSymbolTypes[partyB][symbolType];
	}

	/**
	 * @notice Returns the force close gap ratio.
	 * @param symbolId The symbolId that this ratio is for.
	 * @return The force close gap ratio.
	 */
	function forceCloseGapRatio(uint256 symbolId) external view returns (uint256) {
		return SymbolStorage.layout().forceCloseGapRatio[symbolId];
	}

	/**
	 * @notice Retrieves the funding rate of a party B.
	 * @param symbolId The ID of the symbol.
	 * @param partyB The address of the party B.
	 * @return fundingFee The funding rate of the party B.
	 */
	function getFundingFeesOfPartyB(uint256 symbolId, address partyB) external view returns (FundingFee memory) {
		return SymbolStorage.layout().fundingFees[symbolId][partyB];
	}

	/**
	 * @notice Gets the accumulated funding fees for a list of quotes
	 * @dev Returns the funding fee each position should pay (positive) or receive (negative)
	 * @param quoteIds Array of quote IDs to calculate funding fees for
	 * @return fees Array of funding fees in the same order as quoteIds
	 */
	function getAccumulatedFundingFees(uint256[] memory quoteIds) external view returns (int256[] memory fees) {
		fees = new int256[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) fees[i] = LibQuoteFunding.getAccumulatedFundingFee(quoteIds[i]);
		return fees;
	}
}
