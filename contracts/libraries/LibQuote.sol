// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus, PartiesAggregatedPositions } from "../storages/QuoteStorage.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibAggregateFunding } from "./LibAggregateFunding.sol";

library LibQuote {
	using LockedValuesOps for LockedValues;

	/**
	 * @notice Calculates the remaining open amount of a quote.
	 * @param quote The quote for which to calculate the remaining open amount.
	 * @return The remaining open amount of the quote.
	 */
	function quoteOpenAmount(Quote storage quote) internal view returns (uint256) {
		return quote.quantity - quote.closedAmount;
	}

	/**
	 * @notice Gets the index of an item in an array.
	 * @param array_ The array in which to search for the item.
	 * @param item The item to find the index of.
	 * @return The index of the item in the array, or type(uint256).max if the item is not found.
	 */
	function getIndexOfItem(uint256[] storage array_, uint256 item) internal view returns (uint256) {
		for (uint256 index = 0; index < array_.length; index++) {
			if (array_[index] == item) return index;
		}
		return type(uint256).max;
	}

	/**
	 * @notice Removes an item from an array.
	 * @param array_ The array from which to remove the item.
	 * @param item The item to remove from the array.
	 */
	function removeFromArray(uint256[] storage array_, uint256 item) internal {
		uint256 index = getIndexOfItem(array_, item);
		require(index != type(uint256).max, "LibQuote: Item not Found");
		array_[index] = array_[array_.length - 1];
		array_.pop();
	}

	/**
	 * @notice Removes a quote from the pending quotes of Party A.
	 * @param quote The quote to remove from the pending quotes.
	 */
	function removeFromPartyAPendingQuotes(Quote storage quote) internal {
		removeFromArray(QuoteStorage.layout().partyAPendingQuotes[quote.partyA], quote.id);
	}

	/**
	 * @notice Removes a quote from the pending quotes of Party B.
	 * @param quote The quote to remove from the pending quotes.
	 */
	function removeFromPartyBPendingQuotes(Quote storage quote) internal {
		removeFromArray(QuoteStorage.layout().partyBPendingQuotes[quote.partyB][quote.partyA], quote.id);
	}

	/**
	 * @notice Removes a quote from both Party A's and Party B's pending quotes.
	 * @param quote The quote to remove from the pending quotes.
	 */
	function removeFromPendingQuotes(Quote storage quote) internal {
		removeFromPartyAPendingQuotes(quote);
		removeFromPartyBPendingQuotes(quote);
	}

	/**
	 * @notice Adds to Party B aggregated positions when a position opens.
	 * @param quote The quote being updated.
	 * @param amount The amount to add.
	 */
	function addToPartyBAggregatedPositions(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Check if partyB had any position in this symbol BEFORE adding
		bool hadGlobalPosition = partyBHasPositionInSymbol(quote.partyB, quote.symbolId);
		bool hadPositionPerPartyA = partyBHasPositionInSymbolPerPartyA(quote.partyB, quote.partyA, quote.symbolId);

		PartiesAggregatedPositions storage partyBInfo = quoteLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][quote.positionType];
		PartiesAggregatedPositions storage partyBPerPartyAInfo = quoteLayout.partyBAggregatedPositionsPerPartyA[quote.partyB][quote.partyA][
			quote.symbolId
		][quote.positionType];
		uint256 notional = amount * quote.openedPrice;
		partyBInfo.aggregatedAmount += amount;
		partyBInfo.aggregatedNotional += notional;
		partyBPerPartyAInfo.aggregatedAmount += amount;
		partyBPerPartyAInfo.aggregatedNotional += notional;

		// Add to active symbols if this is the first position in this symbol
		if (!hadGlobalPosition) {
			addToPartyBActiveSymbols(quote.partyB, quote.symbolId);
		}
		if (!hadPositionPerPartyA) {
			addToPartyBActiveSymbolsPerPartyA(quote.partyB, quote.partyA, quote.symbolId);
		}
	}

	/**
	 * @notice Adds to Party A aggregated positions when a position opens.
	 * @param quote The quote being updated.
	 * @param amount The amount to add.
	 */
	function addToPartyAAggregatedPositions(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Check if partyA had any position in this symbol BEFORE adding
		bool hadPosition = partyAHasPositionInSymbol(quote.partyA, quote.symbolId);

		PartiesAggregatedPositions storage partyAInfo = quoteLayout.partyAAggregatedPositions[quote.partyA][quote.symbolId][quote.positionType];
		uint256 notional = amount * quote.openedPrice;
		partyAInfo.aggregatedAmount += amount;
		partyAInfo.aggregatedNotional += notional;

		// Add to active symbols if this is the first position in this symbol
		if (!hadPosition) {
			addToPartyAActiveSymbols(quote.partyA, quote.symbolId);
		}
	}

	/**
	 * @notice Subtracts from Party B aggregated positions when a position closes.
	 * @param quote The quote being updated.
	 * @param amount The amount to subtract.
	 */
	function subFromPartyBAggregatedPositions(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartiesAggregatedPositions storage partyBInfo = quoteLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][quote.positionType];
		PartiesAggregatedPositions storage partyBPerPartyAInfo = quoteLayout.partyBAggregatedPositionsPerPartyA[quote.partyB][quote.partyA][
			quote.symbolId
		][quote.positionType];
		uint256 notional = amount * quote.openedPrice;
		partyBInfo.aggregatedAmount -= amount;
		partyBInfo.aggregatedNotional -= notional;
		partyBPerPartyAInfo.aggregatedAmount -= amount;
		partyBPerPartyAInfo.aggregatedNotional -= notional;

		// Remove from active symbols if no positions remain in this symbol
		if (!partyBHasPositionInSymbol(quote.partyB, quote.symbolId)) {
			removeFromPartyBActiveSymbols(quote.partyB, quote.symbolId);
		}
		if (!partyBHasPositionInSymbolPerPartyA(quote.partyB, quote.partyA, quote.symbolId)) {
			removeFromPartyBActiveSymbolsPerPartyA(quote.partyB, quote.partyA, quote.symbolId);
		}
	}

	/**
	 * @notice Subtracts from Party A aggregated positions when a position closes.
	 * @param quote The quote being updated.
	 * @param amount The amount to subtract.
	 */
	function subFromPartyAAggregatedPositions(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartiesAggregatedPositions storage partyAInfo = quoteLayout.partyAAggregatedPositions[quote.partyA][quote.symbolId][quote.positionType];
		uint256 notional = amount * quote.openedPrice;
		partyAInfo.aggregatedAmount -= amount;
		partyAInfo.aggregatedNotional -= notional;

		// Remove from active symbols if no positions remain in this symbol
		if (!partyAHasPositionInSymbol(quote.partyA, quote.symbolId)) {
			removeFromPartyAActiveSymbols(quote.partyA, quote.symbolId);
		}
	}

	// ===================== Active Symbols Tracking =====================

	/**
	 * @notice Adds a symbol to Party A's active symbols list if not already tracked.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to add.
	 */
	function addToPartyAActiveSymbols(address partyA, uint256 symbolId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.partyAActiveSymbolsIndex[partyA][symbolId] == 0) {
			quoteLayout.partyAActiveSymbols[partyA].push(symbolId);
			quoteLayout.partyAActiveSymbolsIndex[partyA][symbolId] = quoteLayout.partyAActiveSymbols[partyA].length;
		}
	}

	/**
	 * @notice Removes a symbol from Party A's active symbols list using swap-and-pop.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to remove.
	 */
	function removeFromPartyAActiveSymbols(address partyA, uint256 symbolId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256 indexPlusOne = quoteLayout.partyAActiveSymbolsIndex[partyA][symbolId];
		if (indexPlusOne == 0) return;

		uint256 index = indexPlusOne - 1;
		uint256 lastIndex = quoteLayout.partyAActiveSymbols[partyA].length - 1;

		if (index != lastIndex) {
			uint256 lastSymbolId = quoteLayout.partyAActiveSymbols[partyA][lastIndex];
			quoteLayout.partyAActiveSymbols[partyA][index] = lastSymbolId;
			quoteLayout.partyAActiveSymbolsIndex[partyA][lastSymbolId] = indexPlusOne;
		}

		quoteLayout.partyAActiveSymbols[partyA].pop();
		quoteLayout.partyAActiveSymbolsIndex[partyA][symbolId] = 0;
	}

	/**
	 * @notice Adds a symbol to Party B's global active symbols list if not already tracked.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to add.
	 */
	function addToPartyBActiveSymbols(address partyB, uint256 symbolId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.partyBActiveSymbolsIndex[partyB][symbolId] == 0) {
			quoteLayout.partyBActiveSymbols[partyB].push(symbolId);
			quoteLayout.partyBActiveSymbolsIndex[partyB][symbolId] = quoteLayout.partyBActiveSymbols[partyB].length;
		}
	}

	/**
	 * @notice Removes a symbol from Party B's global active symbols list using swap-and-pop.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to remove.
	 */
	function removeFromPartyBActiveSymbols(address partyB, uint256 symbolId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256 indexPlusOne = quoteLayout.partyBActiveSymbolsIndex[partyB][symbolId];
		if (indexPlusOne == 0) return;

		uint256 index = indexPlusOne - 1;
		uint256 lastIndex = quoteLayout.partyBActiveSymbols[partyB].length - 1;

		if (index != lastIndex) {
			uint256 lastSymbolId = quoteLayout.partyBActiveSymbols[partyB][lastIndex];
			quoteLayout.partyBActiveSymbols[partyB][index] = lastSymbolId;
			quoteLayout.partyBActiveSymbolsIndex[partyB][lastSymbolId] = indexPlusOne;
		}

		quoteLayout.partyBActiveSymbols[partyB].pop();
		quoteLayout.partyBActiveSymbolsIndex[partyB][symbolId] = 0;
	}

	/**
	 * @notice Adds a symbol to Party B's active symbols list per Party A if not already tracked.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to add.
	 */
	function addToPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 symbolId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId] == 0) {
			quoteLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].push(symbolId);
			quoteLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId] = quoteLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].length;
		}
	}

	/**
	 * @notice Removes a symbol from Party B's active symbols list per Party A using swap-and-pop.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to remove.
	 */
	function removeFromPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 symbolId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256 indexPlusOne = quoteLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId];
		if (indexPlusOne == 0) return;

		uint256 index = indexPlusOne - 1;
		uint256 lastIndex = quoteLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].length - 1;

		if (index != lastIndex) {
			uint256 lastSymbolId = quoteLayout.partyBActiveSymbolsPerPartyA[partyB][partyA][lastIndex];
			quoteLayout.partyBActiveSymbolsPerPartyA[partyB][partyA][index] = lastSymbolId;
			quoteLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][lastSymbolId] = indexPlusOne;
		}

		quoteLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].pop();
		quoteLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId] = 0;
	}

	/**
	 * @notice Checks if Party A has any position in a symbol (either LONG or SHORT).
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to check.
	 * @return True if Party A has any position in the symbol.
	 */
	function partyAHasPositionInSymbol(address partyA, uint256 symbolId) internal view returns (bool) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		return
			quoteLayout.partyAAggregatedPositions[partyA][symbolId][PositionType.LONG].aggregatedAmount > 0 ||
			quoteLayout.partyAAggregatedPositions[partyA][symbolId][PositionType.SHORT].aggregatedAmount > 0;
	}

	/**
	 * @notice Checks if Party B has any global position in a symbol (either LONG or SHORT).
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to check.
	 * @return True if Party B has any position in the symbol.
	 */
	function partyBHasPositionInSymbol(address partyB, uint256 symbolId) internal view returns (bool) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		return
			quoteLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.LONG].aggregatedAmount > 0 ||
			quoteLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.SHORT].aggregatedAmount > 0;
	}

	/**
	 * @notice Checks if Party B has any position in a symbol per specific Party A (either LONG or SHORT).
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to check.
	 * @return True if Party B has any position in the symbol with Party A.
	 */
	function partyBHasPositionInSymbolPerPartyA(address partyB, address partyA, uint256 symbolId) internal view returns (bool) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		return
			quoteLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][PositionType.LONG].aggregatedAmount > 0 ||
			quoteLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][PositionType.SHORT].aggregatedAmount > 0;
	}

	// ===================== End Active Symbols Tracking =====================

	/**
	 * @notice Subtracts from both Party A and Party B aggregated positions when a position closes.
	 * @param quote The quote being updated.
	 * @param amount The amount to subtract.
	 */
	function subFromPartiesAggregatedPositions(Quote storage quote, uint256 amount) internal {
		subFromPartyBAggregatedPositions(quote, amount);
		subFromPartyAAggregatedPositions(quote, amount);

		// Track aggregate funding for nonce-free Muon verification
		// Note: If funding was charged before this call, accumulatedPaidFunding is already updated
		// and updatePartiesAggregateFunding was called in chargeAccumulatedFundingFee
		LibAggregateFunding.subFromPartiesAggregateFunding(quote, amount);
	}

	/**
	 * @notice Updates Party B aggregated positions notional when the opened price changes.
	 * @param quote The quote being updated.
	 * @param oldOpenedPrice The previous opened price before the change.
	 */
	function updatePartyBAggregatedPositionsNotional(Quote storage quote, uint256 oldOpenedPrice) internal {
		if (oldOpenedPrice == quote.openedPrice) return;
		if (
			quote.quoteStatus != QuoteStatus.OPENED &&
			quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
			quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
		) {
			return;
		}

		uint256 openAmount = quoteOpenAmount(quote);
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartiesAggregatedPositions storage partyBInfo = quoteLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][quote.positionType];
		PartiesAggregatedPositions storage partyBPerPartyAInfo = quoteLayout.partyBAggregatedPositionsPerPartyA[quote.partyB][quote.partyA][
			quote.symbolId
		][quote.positionType];
		if (quote.openedPrice > oldOpenedPrice) {
			uint256 delta = openAmount * (quote.openedPrice - oldOpenedPrice);
			partyBInfo.aggregatedNotional += delta;
			partyBPerPartyAInfo.aggregatedNotional += delta;
		} else {
			uint256 delta = openAmount * (oldOpenedPrice - quote.openedPrice);
			partyBInfo.aggregatedNotional -= delta;
			partyBPerPartyAInfo.aggregatedNotional -= delta;
		}
	}

	/**
	 * @notice Updates Party A aggregated positions notional when the opened price changes.
	 * @param quote The quote being updated.
	 * @param oldOpenedPrice The previous opened price before the change.
	 */
	function updatePartyAAggregatedPositionsNotional(Quote storage quote, uint256 oldOpenedPrice) internal {
		if (oldOpenedPrice == quote.openedPrice) return;
		if (
			quote.quoteStatus != QuoteStatus.OPENED &&
			quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
			quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
		) {
			return;
		}

		uint256 openAmount = quoteOpenAmount(quote);
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartiesAggregatedPositions storage partyAInfo = quoteLayout.partyAAggregatedPositions[quote.partyA][quote.symbolId][quote.positionType];
		if (quote.openedPrice > oldOpenedPrice) {
			partyAInfo.aggregatedNotional += openAmount * (quote.openedPrice - oldOpenedPrice);
		} else {
			partyAInfo.aggregatedNotional -= openAmount * (oldOpenedPrice - quote.openedPrice);
		}
	}

	/**
	 * @notice Updates both Party A and Party B aggregated positions notional when the opened price changes.
	 * @param quote The quote being updated.
	 * @param oldOpenedPrice The previous opened price before the change.
	 */
	function updatePartiesAggregatedPositionsNotional(Quote storage quote, uint256 oldOpenedPrice) internal {
		updatePartyBAggregatedPositionsNotional(quote, oldOpenedPrice);
		updatePartyAAggregatedPositionsNotional(quote, oldOpenedPrice);
	}

	/**
	 * @notice Adds a quote to the open positions.
	 * @param quoteId The ID of the quote to add to the open positions.
	 */
	function addToOpenPositions(uint256 quoteId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		quoteLayout.partyAOpenPositions[quote.partyA].push(quote.id);
		quoteLayout.partyBOpenPositions[quote.partyB][quote.partyA].push(quote.id);

		quoteLayout.partyAPositionsIndex[quote.id] = quoteLayout.partyAPositionsCount[quote.partyA];
		quoteLayout.partyBPositionsIndex[quote.id] = quoteLayout.partyBPositionsCount[quote.partyB][quote.partyA];

		quoteLayout.partyAPositionsCount[quote.partyA] += 1;
		quoteLayout.partyBPositionsCount[quote.partyB][quote.partyA] += 1;

		uint256 openAmount = quoteOpenAmount(quote);
		addToPartyBAggregatedPositions(quote, openAmount);
		addToPartyAAggregatedPositions(quote, openAmount);

		// Track aggregate funding for nonce-free Muon verification
		// Note: quote.accumulatedPaidFunding is set before this function is called
		LibAggregateFunding.addToPartiesAggregateFunding(quote, openAmount);
	}

	/**
	 * @notice Removes a quote from the open positions.
	 * @param quoteId The ID of the quote to remove from the open positions.
	 */
	function removeFromOpenPositions(uint256 quoteId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		uint256 indexOfPartyAPosition = quoteLayout.partyAPositionsIndex[quote.id];
		uint256 indexOfPartyBPosition = quoteLayout.partyBPositionsIndex[quote.id];
		uint256 lastOpenPositionIndex = quoteLayout.partyAPositionsCount[quote.partyA] - 1;
		quoteLayout.partyAOpenPositions[quote.partyA][indexOfPartyAPosition] = quoteLayout.partyAOpenPositions[quote.partyA][lastOpenPositionIndex];
		quoteLayout.partyAPositionsIndex[quoteLayout.partyAOpenPositions[quote.partyA][lastOpenPositionIndex]] = indexOfPartyAPosition;
		quoteLayout.partyAOpenPositions[quote.partyA].pop();

		lastOpenPositionIndex = quoteLayout.partyBPositionsCount[quote.partyB][quote.partyA] - 1;
		quoteLayout.partyBOpenPositions[quote.partyB][quote.partyA][indexOfPartyBPosition] = quoteLayout.partyBOpenPositions[quote.partyB][
			quote.partyA
		][lastOpenPositionIndex];
		quoteLayout.partyBPositionsIndex[quoteLayout.partyBOpenPositions[quote.partyB][quote.partyA][lastOpenPositionIndex]] = indexOfPartyBPosition;
		quoteLayout.partyBOpenPositions[quote.partyB][quote.partyA].pop();

		quoteLayout.partyAPositionsIndex[quote.id] = 0;
		quoteLayout.partyBPositionsIndex[quote.id] = 0;
	}

	/**
	 * @notice Calculates the value of a quote for Party A based on the current price and filled amount.
	 * @param currentPrice The current price of the quote.
	 * @param filledAmount The filled amount of the quote.
	 * @param quote The quote for which to calculate the value.
	 * @return hasMadeProfit A boolean indicating whether Party A has made a profit.
	 * @return pnl The profit or loss value for Party A.
	 */
	function getValueOfQuoteForPartyA(
		uint256 currentPrice,
		uint256 filledAmount,
		Quote storage quote
	) internal view returns (bool hasMadeProfit, uint256 pnl) {
		if (currentPrice > quote.openedPrice) {
			if (quote.positionType == PositionType.LONG) {
				hasMadeProfit = true;
			} else {
				hasMadeProfit = false;
			}
			pnl = ((currentPrice - quote.openedPrice) * filledAmount) / 1e18;
		} else {
			if (quote.positionType == PositionType.LONG) {
				hasMadeProfit = false;
			} else {
				hasMadeProfit = true;
			}
			pnl = ((quote.openedPrice - currentPrice) * filledAmount) / 1e18;
		}
	}

	/**
	 * @notice Gets the trading fee for a quote.
	 * @param quoteId The ID of the quote for which to get the trading fee.
	 * @return fee The trading fee for the quote.
	 */
	function getOpenTradingFee(uint256 quoteId) internal view returns (uint256 fee) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		if (quote.orderType == OrderType.LIMIT) {
			fee = (LibQuote.quoteOpenAmount(quote) * quote.requestedOpenPrice * quote.tradingFee) / 1e36;
		} else {
			fee = (LibQuote.quoteOpenAmount(quote) * quote.marketPrice * quote.tradingFee) / 1e36;
		}
	}
}
