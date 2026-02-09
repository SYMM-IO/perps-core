// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus } from "../storages/QuoteStorage.sol";
import { AggregatedDataStorage, PartiesAggregatedPositions } from "../storages/AggregatedDataStorage.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibAggregateFunding } from "./LibAggregateFunding.sol";
import { LibUtils } from "./LibUtils.sol";

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
	 * @notice Removes a quote from the pending quotes of Party A.
	 * @param quote The quote to remove from the pending quotes.
	 */
	function removeFromPartyAPendingQuotes(Quote storage quote) internal {
		LibUtils.removeFromArray(QuoteStorage.layout().partyAPendingQuotes[quote.partyA], quote.id);
	}

	/**
	 * @notice Removes a quote from the pending quotes of Party B.
	 * @param quote The quote to remove from the pending quotes.
	 */
	function removeFromPartyBPendingQuotes(Quote storage quote) internal {
		LibUtils.removeFromArray(QuoteStorage.layout().partyBPendingQuotes[quote.partyB][quote.partyA], quote.id);
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
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256 notional = amount * quote.openedPrice;

		// Check if partyB had any position in this symbol BEFORE adding (for global active symbols)
		bool hadPositionGlobal = partyBHasPositionInSymbol(quote.partyB, quote.symbolId);
		// Check if partyB had any position in this symbol with this partyA BEFORE adding
		bool hadPositionPerPartyA = partyBHasPositionInSymbolPerPartyA(quote.partyB, quote.partyA, quote.symbolId);

		// Update global partyB aggregated positions (for cross partyB mode UPNL)
		PartiesAggregatedPositions storage partyBGlobalInfo = aggregatedLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][
			quote.positionType
		];
		partyBGlobalInfo.aggregatedAmount += amount;
		partyBGlobalInfo.aggregatedNotional += notional;

		// Update per-partyA aggregated positions
		PartiesAggregatedPositions storage partyBPerPartyAInfo = aggregatedLayout.partyBAggregatedPositionsPerPartyA[quote.partyB][quote.partyA][
			quote.symbolId
		][quote.positionType];
		partyBPerPartyAInfo.aggregatedAmount += amount;
		partyBPerPartyAInfo.aggregatedNotional += notional;

		// Add to global active symbols if this is the first position in this symbol
		if (!hadPositionGlobal) {
			addToPartyBActiveSymbols(quote.partyB, quote.symbolId);
		}
		// Add to per-partyA active symbols if this is the first position with this partyA in this symbol
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
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();

		// Check if partyA had any position in this symbol with this partyB BEFORE adding
		bool hadPositionPerPartyB = partyAHasPositionInSymbolPerPartyB(quote.partyA, quote.partyB, quote.symbolId);

		uint256 notional = amount * quote.openedPrice;

		// Update per-partyB aggregated positions (for solvency calculations with per-hedger funding rates)
		PartiesAggregatedPositions storage partyAPerBInfo = aggregatedLayout.partyAAggregatedPositionsPerPartyB[quote.partyA][quote.partyB][
			quote.symbolId
		][quote.positionType];
		partyAPerBInfo.aggregatedAmount += amount;
		partyAPerBInfo.aggregatedNotional += notional;

		// Add to per-partyB active symbols if this is the first position with this partyB in this symbol
		if (!hadPositionPerPartyB) {
			addToPartyAActiveSymbolsPerPartyB(quote.partyA, quote.partyB, quote.symbolId);
		}
	}

	/**
	 * @notice Subtracts from Party B aggregated positions when a position closes.
	 * @param quote The quote being updated.
	 * @param amount The amount to subtract.
	 */
	function subFromPartyBAggregatedPositions(Quote storage quote, uint256 amount) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256 notional = amount * quote.openedPrice;

		// Update global partyB aggregated positions
		PartiesAggregatedPositions storage partyBGlobalInfo = aggregatedLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][
			quote.positionType
		];
		partyBGlobalInfo.aggregatedAmount -= amount;
		partyBGlobalInfo.aggregatedNotional -= notional;

		// Update per-partyA aggregated positions
		PartiesAggregatedPositions storage partyBPerPartyAInfo = aggregatedLayout.partyBAggregatedPositionsPerPartyA[quote.partyB][quote.partyA][
			quote.symbolId
		][quote.positionType];
		partyBPerPartyAInfo.aggregatedAmount -= amount;
		partyBPerPartyAInfo.aggregatedNotional -= notional;

		// Remove from global active symbols if no positions remain in this symbol
		if (!partyBHasPositionInSymbol(quote.partyB, quote.symbolId)) {
			removeFromPartyBActiveSymbols(quote.partyB, quote.symbolId);
		}
		// Remove from per-partyA active symbols if no positions remain with this partyA in this symbol
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
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256 notional = amount * quote.openedPrice;

		// Update per-partyB aggregated positions
		PartiesAggregatedPositions storage partyAPerBInfo = aggregatedLayout.partyAAggregatedPositionsPerPartyB[quote.partyA][quote.partyB][
			quote.symbolId
		][quote.positionType];
		partyAPerBInfo.aggregatedAmount -= amount;
		partyAPerBInfo.aggregatedNotional -= notional;

		// Remove from per-partyB active symbols if no positions remain with this partyB in this symbol
		if (!partyAHasPositionInSymbolPerPartyB(quote.partyA, quote.partyB, quote.symbolId)) {
			removeFromPartyAActiveSymbolsPerPartyB(quote.partyA, quote.partyB, quote.symbolId);
		}
	}

	// ===================== Global Active Symbols Tracking (PartyB) =====================

	/**
	 * @notice Adds a symbol to Party B's global active symbols list if not already tracked.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to add.
	 */
	function addToPartyBActiveSymbols(address partyB, uint256 symbolId) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		if (aggregatedLayout.partyBActiveSymbolsIndex[partyB][symbolId] == 0) {
			aggregatedLayout.partyBActiveSymbols[partyB].push(symbolId);
			aggregatedLayout.partyBActiveSymbolsIndex[partyB][symbolId] = aggregatedLayout.partyBActiveSymbols[partyB].length;
		}
	}

	/**
	 * @notice Removes a symbol from Party B's global active symbols list using swap-and-pop.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to remove.
	 */
	function removeFromPartyBActiveSymbols(address partyB, uint256 symbolId) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256 indexPlusOne = aggregatedLayout.partyBActiveSymbolsIndex[partyB][symbolId];
		if (indexPlusOne == 0) return;

		uint256 index = indexPlusOne - 1;
		uint256 lastIndex = aggregatedLayout.partyBActiveSymbols[partyB].length - 1;

		if (index != lastIndex) {
			uint256 lastSymbolId = aggregatedLayout.partyBActiveSymbols[partyB][lastIndex];
			aggregatedLayout.partyBActiveSymbols[partyB][index] = lastSymbolId;
			aggregatedLayout.partyBActiveSymbolsIndex[partyB][lastSymbolId] = indexPlusOne;
		}

		aggregatedLayout.partyBActiveSymbols[partyB].pop();
		aggregatedLayout.partyBActiveSymbolsIndex[partyB][symbolId] = 0;
	}

	/**
	 * @notice Checks if Party B has any position in a symbol globally (either LONG or SHORT).
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to check.
	 * @return True if Party B has any position in the symbol.
	 */
	function partyBHasPositionInSymbol(address partyB, uint256 symbolId) internal view returns (bool) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		return
			aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.LONG].aggregatedAmount > 0 ||
			aggregatedLayout.partyBAggregatedPositions[partyB][symbolId][PositionType.SHORT].aggregatedAmount > 0;
	}

	// ===================== Active Symbols Tracking (Per-Counterparty) =====================

	/**
	 * @notice Adds a symbol to Party A's active symbols list per Party B if not already tracked.
	 * @param partyA The address of Party A.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to add.
	 */
	function addToPartyAActiveSymbolsPerPartyB(address partyA, address partyB, uint256 symbolId) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		if (aggregatedLayout.partyAActiveSymbolsIndexPerPartyB[partyA][partyB][symbolId] == 0) {
			aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB].push(symbolId);
			aggregatedLayout.partyAActiveSymbolsIndexPerPartyB[partyA][partyB][symbolId] = aggregatedLayout
				.partyAActiveSymbolsPerPartyB[partyA][partyB]
				.length;
		}
	}

	/**
	 * @notice Removes a symbol from Party A's active symbols list per Party B using swap-and-pop.
	 * @param partyA The address of Party A.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to remove.
	 */
	function removeFromPartyAActiveSymbolsPerPartyB(address partyA, address partyB, uint256 symbolId) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256 indexPlusOne = aggregatedLayout.partyAActiveSymbolsIndexPerPartyB[partyA][partyB][symbolId];
		if (indexPlusOne == 0) return;

		uint256 index = indexPlusOne - 1;
		uint256 lastIndex = aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB].length - 1;

		if (index != lastIndex) {
			uint256 lastSymbolId = aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB][lastIndex];
			aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB][index] = lastSymbolId;
			aggregatedLayout.partyAActiveSymbolsIndexPerPartyB[partyA][partyB][lastSymbolId] = indexPlusOne;
		}

		aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB].pop();
		aggregatedLayout.partyAActiveSymbolsIndexPerPartyB[partyA][partyB][symbolId] = 0;
	}

	/**
	 * @notice Adds a symbol to Party B's active symbols list per Party A if not already tracked.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to add.
	 */
	function addToPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 symbolId) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		if (aggregatedLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId] == 0) {
			aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].push(symbolId);
			aggregatedLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId] = aggregatedLayout
				.partyBActiveSymbolsPerPartyA[partyB][partyA]
				.length;
		}
	}

	/**
	 * @notice Removes a symbol from Party B's active symbols list per Party A using swap-and-pop.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to remove.
	 */
	function removeFromPartyBActiveSymbolsPerPartyA(address partyB, address partyA, uint256 symbolId) internal {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		uint256 indexPlusOne = aggregatedLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId];
		if (indexPlusOne == 0) return;

		uint256 index = indexPlusOne - 1;
		uint256 lastIndex = aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].length - 1;

		if (index != lastIndex) {
			uint256 lastSymbolId = aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA][lastIndex];
			aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA][index] = lastSymbolId;
			aggregatedLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][lastSymbolId] = indexPlusOne;
		}

		aggregatedLayout.partyBActiveSymbolsPerPartyA[partyB][partyA].pop();
		aggregatedLayout.partyBActiveSymbolsIndexPerPartyA[partyB][partyA][symbolId] = 0;
	}

	/**
	 * @notice Checks if Party A has any position in a symbol per specific Party B (either LONG or SHORT).
	 * @param partyA The address of Party A.
	 * @param partyB The address of Party B.
	 * @param symbolId The symbol ID to check.
	 * @return True if Party A has any position in the symbol with Party B.
	 */
	function partyAHasPositionInSymbolPerPartyB(address partyA, address partyB, uint256 symbolId) internal view returns (bool) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		return
			aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][PositionType.LONG].aggregatedAmount > 0 ||
			aggregatedLayout.partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][PositionType.SHORT].aggregatedAmount > 0;
	}

	/**
	 * @notice Checks if Party B has any position in a symbol per specific Party A (either LONG or SHORT).
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param symbolId The symbol ID to check.
	 * @return True if Party B has any position in the symbol with Party A.
	 */
	function partyBHasPositionInSymbolPerPartyA(address partyB, address partyA, uint256 symbolId) internal view returns (bool) {
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		return
			aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][PositionType.LONG].aggregatedAmount > 0 ||
			aggregatedLayout.partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][PositionType.SHORT].aggregatedAmount > 0;
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
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();

		// Update global partyB aggregated positions
		PartiesAggregatedPositions storage partyBGlobalInfo = aggregatedLayout.partyBAggregatedPositions[quote.partyB][quote.symbolId][
			quote.positionType
		];
		// Update per-partyA aggregated positions
		PartiesAggregatedPositions storage partyBPerPartyAInfo = aggregatedLayout.partyBAggregatedPositionsPerPartyA[quote.partyB][quote.partyA][
			quote.symbolId
		][quote.positionType];

		if (quote.openedPrice > oldOpenedPrice) {
			uint256 delta = openAmount * (quote.openedPrice - oldOpenedPrice);
			partyBGlobalInfo.aggregatedNotional += delta;
			partyBPerPartyAInfo.aggregatedNotional += delta;
		} else {
			uint256 delta = openAmount * (oldOpenedPrice - quote.openedPrice);
			partyBGlobalInfo.aggregatedNotional -= delta;
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
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();
		PartiesAggregatedPositions storage partyAPerBInfo = aggregatedLayout.partyAAggregatedPositionsPerPartyB[quote.partyA][quote.partyB][
			quote.symbolId
		][quote.positionType];
		if (quote.openedPrice > oldOpenedPrice) {
			uint256 delta = openAmount * (quote.openedPrice - oldOpenedPrice);
			partyAPerBInfo.aggregatedNotional += delta;
		} else {
			uint256 delta = openAmount * (oldOpenedPrice - quote.openedPrice);
			partyAPerBInfo.aggregatedNotional -= delta;
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

		quoteLayout.partyAPositionsCount[quote.partyA] -= 1;
		quoteLayout.partyBPositionsCount[quote.partyB][quote.partyA] -= 1;
		quoteLayout.partyBPositionsCount[quote.partyB][address(0)] -= 1;
	}

	/**
	 * @notice Fully closes an open position: updates avgClosedPrice, subtracts aggregated positions, and removes from open positions.
	 * @param quoteId The ID of the quote to close.
	 * @param closedPrice The price at which the position is closed.
	 * @return closedAmount The remaining open amount that was closed.
	 */
	function closePositionFully(uint256 quoteId, uint256 closedPrice) internal returns (uint256 closedAmount) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		closedAmount = quoteOpenAmount(quote);
		quote.avgClosedPrice = (quote.avgClosedPrice * quote.closedAmount + closedAmount * closedPrice) / (quote.closedAmount + closedAmount);
		subFromPartiesAggregatedPositions(quote, closedAmount);
		quote.closedAmount = quote.quantity;
		removeFromOpenPositions(quote.id);
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
