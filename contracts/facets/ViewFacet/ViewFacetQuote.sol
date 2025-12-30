// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage, Quote, PositionType, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { IViewFacetQuote } from "./IViewFacetQuote.sol";

contract ViewFacetQuote is IViewFacetQuote {
	/**
	 * @notice Returns the details of a quote by its ID.
	 * @param quoteId The ID of the quote.
	 * @return The details of the quote.
	 */
	function getQuote(uint256 quoteId) external view returns (Quote memory) {
		return QuoteStorage.layout().quotes[quoteId];
	}

	/**
	 * @notice Returns an array of quotes associated with a parent quote ID.
	 * @param quoteId The parent quote ID.
	 * @param size The size of the array.
	 * @return An array of quotes.
	 */
	function getQuotesByParent(uint256 quoteId, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		Quote memory quote = quoteLayout.quotes[quoteId];
		quotes[0] = quote;
		for (uint256 i = 1; i < size; i++) {
			if (quote.parentId == 0) {
				break;
			}
			quote = quoteLayout.quotes[quote.parentId];
			quotes[i] = quote;
		}
		return quotes;
	}

	/**
	 * @notice Returns an array of quote IDs associated with a party A address.
	 * @param partyA The address of party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of quote IDs.
	 */
	function quoteIdsOf(address partyA, uint256 start, uint256 size) external view returns (uint256[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.quoteIdsOf[partyA].length < start + size) {
			size = quoteLayout.quoteIdsOf[partyA].length - start;
		}
		uint256[] memory quoteIds = new uint256[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			quoteIds[i - start] = quoteLayout.quoteIdsOf[partyA][i];
			unchecked {
				++i;
			}
		}
		return quoteIds;
	}

	/**
	 * @notice Returns an array of quotes associated with a party A address.
	 * @param partyA The address of party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of quotes.
	 */
	function getQuotes(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.quoteIdsOf[partyA].length < start + size) {
			size = quoteLayout.quoteIdsOf[partyA].length - start;
		}
		Quote[] memory quotes = new Quote[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			quotes[i - start] = quoteLayout.quotes[quoteLayout.quoteIdsOf[partyA][i]];
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/**
	 * @notice Returns the length of the quotes array associated with a user.
	 * @param user The address of the user.
	 * @return The length of the quotes array.
	 */
	function quotesLength(address user) external view returns (uint256) {
		return QuoteStorage.layout().quoteIdsOf[user].length;
	}

	/**
	 * @notice Returns the number of open positions associated with a party A address.
	 * @param partyA The address of party A.
	 * @return The number of open positions.
	 */
	function partyAPositionsCount(address partyA) external view returns (uint256) {
		return QuoteStorage.layout().partyAPositionsCount[partyA];
	}

	/**
	 * @notice Internal: Returns an array of open positions associated with a party A address.
	 * @param partyA The address of party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of open positions.
	 */
	function getPartyAOpenPositionsImp(address partyA, uint256 start, uint256 size) internal view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		uint256[] memory partyAOpenPositions = quoteLayout.partyAOpenPositions[partyA];
		if (partyAOpenPositions.length < start + size) size = partyAOpenPositions.length - start;

		Quote[] memory quotes = new Quote[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			quotes[i - start] = quoteLayout.quotes[partyAOpenPositions[i]];
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/**
	 * @notice Returns an array of open positions associated with a party A address.
	 * @param partyA The address of party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of open positions.
	 */
	function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory) {
		return getPartyAOpenPositionsImp(partyA, start, size);
	}

	/**
	 * @notice Internal: Returns an array of open positions associated with a party B address and a specific party A address.
	 * @param partyB The address of party B.
	 * @param partyA The address of party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of open positions.
	 */
	function getPartyBOpenPositionsImp(address partyB, address partyA, uint256 start, uint256 size) internal view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256[] memory partyBOpenPositions = quoteLayout.partyBOpenPositions[partyB][partyA];
		if (partyBOpenPositions.length < start + size) size = partyBOpenPositions.length - start;

		Quote[] memory quotes = new Quote[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			quotes[i - start] = quoteLayout.quotes[partyBOpenPositions[i]];
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/**
	 * @notice Returns an array of open positions associated with a party B address and a specific party A address.
	 * @param partyB The address of party B.
	 * @param partyA The address of party A.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of open positions.
	 */
	function getPartyBOpenPositions(address partyB, address partyA, uint256 start, uint256 size) external view returns (Quote[] memory) {
		return getPartyBOpenPositionsImp(partyB, partyA, start, size);
	}

	/**
	 * @notice Returns an array of positions associated with a party B address.
	 * @param partyB The address of party B.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of positions.
	 */
	function getPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		uint j = 0;
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			Quote memory quote = quoteLayout.quotes[i];
			if (quote.partyB == partyB) {
				quotes[j] = quote;
				j += 1;
			}
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/**
	 * @notice Returns an array of open positions associated with a party B address.
	 * @param partyB The address of party B.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of open positions.
	 */
	function getOpenPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		uint j = 0;
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			Quote memory quote = quoteLayout.quotes[i];
			if (
				quote.partyB == partyB &&
				(quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING)
			) {
				quotes[j] = quote;
				j += 1;
			}
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/**
	 * @notice Returns an array of active positions associated with a party B address.
	 * @param partyB The address of party B.
	 * @param start The starting index.
	 * @param size The size of the array.
	 * @return An array of active positions.
	 */
	function getActivePositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		uint j = 0;
		uint256 end = start + size;
		for (uint256 i = start; i < end; ) {
			Quote memory quote = quoteLayout.quotes[i];
			if (
				quote.partyB == partyB &&
				quote.quoteStatus != QuoteStatus.CANCELED &&
				quote.quoteStatus != QuoteStatus.CLOSED &&
				quote.quoteStatus != QuoteStatus.EXPIRED &&
				quote.quoteStatus != QuoteStatus.LIQUIDATED
			) {
				quotes[j] = quote;
				j += 1;
			}
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/**
	 * @notice Returns the number of positions associated with a party B address and a specific party A address.
	 * @param partyB The address of party B.
	 * @param partyA The address of party A.
	 * @return The number of positions.
	 */
	function partyBPositionsCount(address partyB, address partyA) external view returns (uint256) {
		return QuoteStorage.layout().partyBPositionsCount[partyB][partyA];
	}

	/**
	 * @notice Returns total open position amounts and average open prices for a party B and symbol, grouped by position type.
	 * @param partyB The address of party B.
	 * @param symbolId The symbol ID.
	 * @return amounts An array of position types with total open amounts and average open prices (LONG, SHORT).
	 */
	function getPartyBTotalPositionAmountsBySymbol(
		address partyB,
		uint256 symbolId
	) external view returns (TotalPositionAmount[] memory amounts) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		amounts = new TotalPositionAmount[](2);
		uint256 longAmount = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.LONG].totalAmounts;
		uint256 shortAmount = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.SHORT].totalAmounts;
		uint256 longNotional = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.LONG].totalNotionals;
		uint256 shortNotional = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.SHORT].totalNotionals;
		amounts[0] = TotalPositionAmount(
			PositionType.LONG,
			longAmount,
			longAmount == 0 ? 0 : longNotional / longAmount
		);
		amounts[1] = TotalPositionAmount(
			PositionType.SHORT,
			shortAmount,
			shortAmount == 0 ? 0 : shortNotional / shortAmount
		);
	}

	/**
	 * @notice Returns total open amounts and average open prices for a party B across symbols, grouped by position type.
	 * @dev Zero-amount entries are removed. Use offset/limit to paginate symbol ids.
	 * @param partyB The address of party B.
	 * @param offset Start symbol index (0-based; symbolId = offset + 1).
	 * @param limit Maximum symbols to process starting at offset.
	 */
	function getPartyBTotalPositionAmounts(
		address partyB,
		uint256 offset,
		uint256 limit
	) external view returns (PartyBPositionBySymbol[] memory results) {
		return _getPartyBTotalPositionAmounts(partyB, offset, limit);
	}

	/**
	 * @notice returns totals for all symbols (full list).
	 * @dev Zero-amount entries are removed.
	 * @param partyB The address of party B.
	 */
	function getPartyBTotalPositionAmounts(address partyB) external view returns (PartyBPositionBySymbol[] memory results) {
		uint256 lastId = SymbolStorage.layout().lastId;
		if (lastId == 0) {
			return new PartyBPositionBySymbol[](0);
		}
		return _getPartyBTotalPositionAmounts(partyB, 0, lastId);
	}

	function _getPartyBTotalPositionAmounts(
		address partyB,
		uint256 offset,
		uint256 limit
	) internal view returns (PartyBPositionBySymbol[] memory results) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		uint256 totalSymbols = symbolLayout.lastId;
		if (totalSymbols == 0 || limit == 0 || offset >= totalSymbols) {
			return new PartyBPositionBySymbol[](0);
		}

		uint256 end = offset + limit;
		if (end > totalSymbols) end = totalSymbols;

		// pre allocate two slots per symbol (long + short)
		uint256 maxItems = (end - offset) * 2;
		results = new PartyBPositionBySymbol[](maxItems);
		uint256 count;

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		for (uint256 symbolIndex = offset + 1; symbolIndex <= end; ) {
			uint256 symbolId = symbolIndex;

			// LONG
			uint256 longAmount = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.LONG].totalAmounts;
			if (longAmount > 0) {
				uint256 longNotional = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.LONG].totalNotionals;
				results[count] = PartyBPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.LONG,
					totalOpenAmount: longAmount,
					avgOpenPrice: longNotional / longAmount
				});
				count++;
			}

			// SHORT
			uint256 shortAmount = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.SHORT].totalAmounts;
			if (shortAmount > 0) {
				uint256 shortNotional = quoteLayout.partyBTotalPositionsInfo[partyB][symbolId][PositionType.SHORT].totalNotionals;
				results[count] = PartyBPositionBySymbol({
					symbolId: symbolId,
					positionType: PositionType.SHORT,
					totalOpenAmount: shortAmount,
					avgOpenPrice: shortNotional / shortAmount
				});
				count++;
			}

			unchecked {
				++symbolIndex;
			}
		}

		if (count == results.length) {
			return results;
		}

		// trim the pre allocated array to the actual number of results
		assembly {
			mstore(results, count)
		}
	}

	/**
	 * @notice Returns an array of pending quotes associated with a party A address.
	 * @param partyA The address of party A.
	 * @return An array of pending quotes.
	 */
	function getPartyAPendingQuotes(address partyA) external view returns (uint256[] memory) {
		return QuoteStorage.layout().partyAPendingQuotes[partyA];
	}

	/**
	 * @notice Returns an array of pending quotes associated with a party B address and a specific party A address.
	 * @param partyB The address of party B.
	 * @param partyA The address of party A.
	 * @return An array of pending quotes.
	 */
	function getPartyBPendingQuotes(address partyB, address partyA) external view returns (uint256[] memory) {
		return QuoteStorage.layout().partyBPendingQuotes[partyB][partyA];
	}

	/**
	 * @notice Retrieves a filtered list of quotes based on a bitmap. The method returns quotes only if sufficient gas remains.
	 * @param bitmap A structured data type representing a bitmap, used to indicate which quotes to retrieve based on their positions. The bitmap consists of multiple elements, each with an offset and a 256-bit integer representing selectable quotes.
	 * @param gasNeededForReturn The minimum gas required to complete the function execution and return the data. This ensures the function doesn't start a retrieval that it can't complete.
	 * @return quotes An array of `Quote` structures, each corresponding to a quote identified by the bitmap.
	 */
	function getQuotesWithBitmap(Bitmap calldata bitmap, uint256 gasNeededForReturn) external view returns (Quote[] memory quotes) {
		QuoteStorage.Layout storage qL = QuoteStorage.layout();

		quotes = new Quote[](bitmap.size);
		uint256 quoteIndex = 0;

		for (uint256 i = 0; i < bitmap.elements.length; ++i) {
			uint256 bits = bitmap.elements[i].bitmap;
			uint256 offset = bitmap.elements[i].offset;
			while (bits > 0 && gasleft() > gasNeededForReturn) {
				if ((bits & 1) > 0) {
					quotes[quoteIndex] = qL.quotes[offset];
					++quoteIndex;
				}
				++offset;
				bits >>= 1;
			}
		}
	}

	/**
	 * @notice Retrieves the next available quote ID.
	 * @return The next available quote ID.
	 */
	function getNextQuoteId() external view returns (uint256) {
		return QuoteStorage.layout().lastId;
	}

	/**
	 * @notice Retrieves the close ID of a quote.
	 * @param quoteId The ID of the quote.
	 * @return The close ID of the quote.
	 */
	function getQuoteCloseId(uint256 quoteId) external view returns (uint256) {
		return QuoteStorage.layout().closeIds[quoteId];
	}

	/**
	 * @notice Returns the parameters needed to calculate party A UPNL offchain.
	 * @param partyA Address of partyA
	 * @param quoteStart Quote start ID
	 * @param quoteEnd Quote end ID
	 * @param getCount whether to return the position Count
	 * @return positionsCount  Number of positions
	 * @return partyBsAllocated  An array of party B Allocated Balance.
	 * @return partyBs  An array of quotes partyBs.
	 * @return quoteIds  An array of quotes IDs.
	 * @return symbolIds  An array of quotes Symbols IDs.
	 * @return symbolNames  An array of quotes Symbols names.
	 * @return openPrices  An array of quotes open prices.
	 * @return remainingOpenAmount  An array of quotes available amounts.
	 * @return positionType  An array of quotes positions Type.
	 */
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
		)
	{
		if (getCount) {
			positionsCount = QuoteStorage.layout().partyAPositionsCount[partyA];
		}

		Quote[] memory quotes = getPartyAOpenPositionsImp(partyA, quoteStart, quoteEnd);
		uint256 len = quotes.length;

		// allocate all arrays
		partyBsAllocated = new uint256[](len);
		partyBs = new address[](len);
		quoteIds = new uint256[](len);
		symbolIds = new uint256[](len);
		symbolNames = new string[](len);
		openPrices = new uint256[](len);
		remainingOpenAmount = new uint256[](len);
		positionType = new uint256[](len);

		for (uint i = 0; i < len; i++) {
			partyBs[i] = quotes[i].partyB;
			partyBsAllocated[i] = AccountStorage.layout().partyBAllocatedBalances[partyBs[i]][partyA];
			quoteIds[i] = quotes[i].id;
			remainingOpenAmount[i] = quotes[i].quantity - quotes[i].closedAmount;
			openPrices[i] = quotes[i].requestedOpenPrice;
			symbolNames[i] = SymbolStorage.layout().symbols[quotes[i].symbolId].name;
			positionType[i] = uint256(quotes[i].positionType);
			symbolIds[i] = quotes[i].symbolId;
		}
	}

	/**
	 * @notice Returns the parameters needed to calculate Party B UPNL offchain.
	 * @param partyA Address of partyA
	 * @param partyB Address of partyB
	 * @param quoteStart Quote start ID
	 * @param quoteEnd Quote end ID
	 * @return positionsCount  Number of positions
	 * @return partyBsAllocated  party B Allocated Balance.
	 * @return quoteIds  An array of quotes IDs.
	 * @return symbolIds  An array of quotes Symbols IDs.
	 * @return symbolNames  An array of quotes Symbols names.
	 * @return openPrices  An array of quotes open prices.
	 * @return remainingOpenAmount  An array of quotes available amounts.
	 * @return positionType  An array of quotes positions Type.
	 */
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
		)
	{
		if (getCount) {
			positionsCount = QuoteStorage.layout().partyBPositionsCount[partyB][partyA];
		}

		Quote[] memory quotes = getPartyBOpenPositionsImp(partyB, partyA, quoteStart, quoteEnd);
		uint256 len = quotes.length;

		// allocate arrays
		partyBsAllocated = new uint256[](len);
		quoteIds = new uint256[](len);
		symbolIds = new uint256[](len);
		symbolNames = new string[](len);
		openPrices = new uint256[](len);
		remainingOpenAmount = new uint256[](len);
		positionType = new uint256[](len);

		for (uint i = 0; i < len; i++) {
			partyBsAllocated[i] = AccountStorage.layout().partyBAllocatedBalances[partyB][partyA];
			quoteIds[i] = quotes[i].id;
			remainingOpenAmount[i] = quotes[i].quantity - quotes[i].closedAmount;
			openPrices[i] = quotes[i].requestedOpenPrice;
			symbolNames[i] = SymbolStorage.layout().symbols[quotes[i].symbolId].name;
			positionType[i] = uint256(quotes[i].positionType);
			symbolIds[i] = quotes[i].symbolId;
		}
	}
}
