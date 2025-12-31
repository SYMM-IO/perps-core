// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus, PartyBPositionsInfo } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";

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
	 * @notice Updates Party B open position amounts when positions open or close.
	 * @param quote The quote being updated.
	 * @param amount The amount to add or subtract.
	 */
	function addToPartyBOpenPositionAmounts(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		quoteLayout.partyBTotalPositionsInfo[quote.partyB][quote.symbolId][quote.positionType].totalAmounts += amount;
		quoteLayout.partyBTotalPositionsInfo[quote.partyB][quote.symbolId][quote.positionType].totalNotionals += amount * quote.openedPrice;
	}

	function subFromPartyBOpenPositionAmounts(Quote storage quote, uint256 amount) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		quoteLayout.partyBTotalPositionsInfo[quote.partyB][quote.symbolId][quote.positionType].totalAmounts -= amount;
		quoteLayout.partyBTotalPositionsInfo[quote.partyB][quote.symbolId][quote.positionType].totalNotionals -= amount * quote.openedPrice;
	}

	function updatePartyBOpenPositionNotional(Quote storage quote, uint256 oldOpenedPrice) internal {
		if (oldOpenedPrice == quote.openedPrice) return;
		if (
			quote.quoteStatus != QuoteStatus.OPENED &&
			quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
			quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
		) {
			return;
		}
		uint256 openAmount = quoteOpenAmount(quote);
		if (openAmount == 0) return;

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		PartyBPositionsInfo storage info = quoteLayout.partyBTotalPositionsInfo[quote.partyB][quote.symbolId][quote.positionType];
		if (quote.openedPrice > oldOpenedPrice) {
			info.totalNotionals += openAmount * (quote.openedPrice - oldOpenedPrice);
		} else {
			info.totalNotionals -= openAmount * (oldOpenedPrice - quote.openedPrice);
		}
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

		addToPartyBOpenPositionAmounts(quote, quoteOpenAmount(quote));
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
