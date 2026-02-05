// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, PositionType } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibQuote } from "./LibQuote.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";

library LibSolvency {
	using LockedValuesOps for LockedValues;

	/**
	 * @dev Checks whether both parties (Party A and Party B) will remain solvent after opening positions for given quotes.
	 * @param quoteIds The ID of the quotes for which the positions is being opened.
	 * @param filledAmounts The amount of the quotes that will be filled by opening the positions.
	 * @param marketPrices The market price of positions that will be opened.
	 * @param upnlPartyB The upnl of partyB
	 * @param upnlPartyA The upnl of partyA
	 * @param partyB Address of partyB
	 * @param partyA Address of partyA
	 * @return A boolean indicating whether both parties remain solvent after opening the position.
	 */
	function isSolventAfterOpenPosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory marketPrices,
		int256 upnlPartyB,
		int256 upnlPartyA,
		address partyB,
		address partyA
	) internal view returns (bool) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		int256 partyBAvailableBalance = LibAccount.partyBAvailableBalanceForLiquidation(upnlPartyB, partyB, partyA);
		int256 partyAAvailableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			upnlPartyA,
			AccountStorage.layout().allocatedBalances[partyA],
			partyA
		);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];
			uint256 filledAmount = filledAmounts[i];
			uint256 marketPrice = marketPrices[i];

			Quote storage quote = quoteLayout.quotes[quoteId];

			if (quote.positionType == PositionType.LONG) {
				if (quote.openedPrice >= marketPrice) {
					uint256 diff = (filledAmount * (quote.openedPrice - marketPrice)) / 1e18;
					partyAAvailableBalance -= int256(diff);
					partyBAvailableBalance += int256(diff);
				} else {
					uint256 diff = (filledAmount * (marketPrice - quote.openedPrice)) / 1e18;
					partyBAvailableBalance -= int256(diff);
					partyAAvailableBalance += int256(diff);
				}
			} else if (quote.positionType == PositionType.SHORT) {
				if (quote.openedPrice >= marketPrice) {
					uint256 diff = (filledAmount * (quote.openedPrice - marketPrice)) / 1e18;
					partyBAvailableBalance -= int256(diff);
					partyAAvailableBalance += int256(diff);
				} else {
					uint256 diff = (filledAmount * (marketPrice - quote.openedPrice)) / 1e18;
					partyAAvailableBalance -= int256(diff);
					partyBAvailableBalance += int256(diff);
				}
			}
		}
		require(partyBAvailableBalance >= 0 && partyAAvailableBalance >= 0, "LibSolvency: Available balance is lower than zero");
		return true;
	}

	/**
	 * @dev Calculates the available balances for Party A and Party B after closing positions for given quotes.
	 * @param quoteIds The ID of the quotes for which the position is being closed.
	 * @param filledAmounts The amount of the quotes that will be filled by closing the position.
	 * @param closedPrices The price at which the positions will be closed.
	 * @param marketPrices The market price of positions that will be closed.
	 * @param upnlPartyB The upnl of partyB
	 * @param upnlPartyA The upnl of partyA
	 * @param partyB Address of partyB
	 * @param partyA Address of partyA
	 * @return partyBAvailableBalance The available balance for Party B after closing the position.
	 * @return partyAAvailableBalance The available balance for Party A after closing the position.
	 */
	function getAvailableBalanceAfterClosePosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		uint256[] memory marketPrices,
		int256 upnlPartyB,
		int256 upnlPartyA,
		address partyB,
		address partyA
	) internal view returns (int256 partyBAvailableBalance, int256 partyAAvailableBalance) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		partyBAvailableBalance = LibAccount.partyBAvailableBalanceForLiquidation(upnlPartyB, partyB, partyA);
		partyAAvailableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			upnlPartyA,
			AccountStorage.layout().allocatedBalances[partyA],
			partyA
		);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];
			uint256 filledAmount = filledAmounts[i];
			uint256 closedPrice = closedPrices[i];
			uint256 marketPrice = marketPrices[i];

			Quote storage quote = quoteLayout.quotes[quoteId];
			uint256 unlockedAmount = (filledAmount * (quote.lockedValues.cva + quote.lockedValues.lf)) / LibQuote.quoteOpenAmount(quote);

			partyBAvailableBalance += int256(unlockedAmount);
			partyAAvailableBalance += int256(unlockedAmount);

			// Deduct close fee from PartyA's available balance (only PartyA pays close fees)
			uint256 closeFee = (filledAmount * closedPrice * quote.closeFee) / 1e36;
			partyAAvailableBalance -= int256(closeFee);

			if (quote.positionType == PositionType.LONG) {
				if (closedPrice >= marketPrice) {
					uint256 diff = (filledAmount * (closedPrice - marketPrice)) / 1e18;
					partyBAvailableBalance -= int256(diff);
					partyAAvailableBalance += int256(diff);
				} else {
					uint256 diff = (filledAmount * (marketPrice - closedPrice)) / 1e18;
					partyBAvailableBalance += int256(diff);
					partyAAvailableBalance -= int256(diff);
				}
			} else if (quote.positionType == PositionType.SHORT) {
				if (closedPrice <= marketPrice) {
					uint256 diff = (filledAmount * (marketPrice - closedPrice)) / 1e18;
					partyBAvailableBalance -= int256(diff);
					partyAAvailableBalance += int256(diff);
				} else {
					uint256 diff = (filledAmount * (closedPrice - marketPrice)) / 1e18;
					partyBAvailableBalance += int256(diff);
					partyAAvailableBalance -= int256(diff);
				}
			}
		}
	}

	/**
	 * @dev Checks whether both parties (Party A and Party B) will remain solvent after closing positions for given quotes.
	 * @param quoteIds The ID of the quotes for which the position is being closed.
	 * @param filledAmounts The amount of the quotes that will be filled by closing the position.
	 * @param closedPrices The price at which the positions will be closed.
	 * @param marketPrices The market price of positions that will be closed.
	 * @param upnlPartyB The upnl of partyB
	 * @param upnlPartyA The upnl of partyA
	 * @param partyB Address of partyB
	 * @param partyA Address of partyA
	 * @return A boolean indicating whether both parties remain solvent after closing the position.
	 */
	function isSolventAfterClosePosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		uint256[] memory marketPrices,
		int256 upnlPartyB,
		int256 upnlPartyA,
		address partyB,
		address partyA
	) internal view returns (bool) {
		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = getAvailableBalanceAfterClosePosition(
			quoteIds,
			filledAmounts,
			closedPrices,
			marketPrices,
			upnlPartyB,
			upnlPartyA,
			partyB,
			partyA
		);
		require(partyBAvailableBalance >= 0 && partyAAvailableBalance >= 0, "LibSolvency: Available balance is lower than zero");
		return true;
	}

	/**
	 * @notice Calculates the maximum close amount that keeps PartyA at the edge of liquidation (available balance = 0).
	 * @dev This is used when a full close would make PartyA insolvent - instead we close only enough to bring them
	 *      to the liquidation threshold.
	 *
	 * ## Mathematical Model
	 *
	 * The balance change when closing amount `x` follows the same model as `getAvailableBalanceAfterClosePosition`:
	 *
	 *   newBalance = currentBalance + unlockedAmount + pnlAdjustment - closeFee
	 *
	 * Where (for closing amount `x`):
	 *   unlockedAmount = x * (cva + lf) / openAmount
	 *   pnlAdjustment = x * (closedPrice - marketPrice) / 1e18 (sign depends on position type)
	 *   closeFee = x * closedPrice * quote.closeFee / 1e36
	 *
	 * ## Rate-Based Formulation
	 *
	 * We express the balance change as a linear function of close amount:
	 *   balanceChange(x) = x * totalRate / 1e18
	 *   totalRate = unlockRate + pnlRate - feeRate
	 *
	 * Where:
	 *   unlockRate = (cva + lf) * 1e18 / openAmount
	 *   feeRate = closedPrice * closeFee / 1e18
	 *   pnlRate = ±(closedPrice - marketPrice) (positive when PartyA profits)
	 *
	 * ## Solving for Max Close Amount
	 *
	 * To bring balance to exactly 0: currentBalance + x * totalRate / 1e18 = 0
	 * Solving: x = currentBalance * 1e18 / (-totalRate) (when totalRate < 0)
	 *
	 * ## Case Analysis
	 *
	 * - totalRate > 0: Closing is BENEFICIAL. If full close fails, partial can't help → revert
	 * - totalRate < 0: Closing is HARMFUL. Limit close amount to avoid insolvency
	 * - totalRate = 0: Closing is NEUTRAL. Full close or revert (no partial solution)
	 *
	 * ## Rounding Behavior
	 *
	 * Integer division rounds DOWN, which is intentional and conservative:
	 * - We close slightly LESS than what would bring balance to exactly 0
	 * - This leaves PartyA with a small positive balance (safer)
	 * - Invariant: currentBalance + (maxCloseAmount * totalRate / 1e18) >= 0
	 *
	 * @param quoteId The ID of the quote for which to calculate max close amount
	 * @param closedPrice The price at which the position would be closed
	 * @param marketPrice The current market price
	 * @param upnlPartyA The unrealized PnL of PartyA
	 * @return maxCloseAmount The maximum amount that can be closed while keeping PartyA solvent
	 * @return canCloseAll True if the full quantityToClose can be closed without making PartyA insolvent
	 */
	function calculateMaxCloseAmountToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		uint256 marketPrice,
		int256 upnlPartyA
	) internal view returns (uint256 maxCloseAmount, bool canCloseAll) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		require(openAmount > 0, "LibSolvency: No open amount");

		// Get current available balance for liquidation
		int256 currentBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			upnlPartyA,
			AccountStorage.layout().allocatedBalances[quote.partyA],
			quote.partyA
		);

		// Calculate the effect per unit of close amount (scaled by 1e18 for precision)
		// unlockRate = (cva + lf) * 1e18 / openAmount
		uint256 unlockRate = ((quote.lockedValues.cva + quote.lockedValues.lf) * 1e18) / openAmount;

		// Calculate fee rate per unit of close amount (scaled by 1e18)
		// feeRate = closedPrice * closeFee / 1e18 (since closeFee is already in 1e18 scale)
		uint256 feeRate = (closedPrice * quote.closeFee) / 1e18;

		// Calculate pnl effect per unit based on position type and price direction
		// This matches the logic in getAvailableBalanceAfterClosePosition
		// For LONG: PartyA profits when closedPrice > marketPrice
		// For SHORT: PartyA profits when closedPrice < marketPrice
		int256 pnlRate;
		if (quote.positionType == PositionType.LONG) {
			if (closedPrice >= marketPrice) {
				// PartyA profits - positive effect on balance
				pnlRate = int256(closedPrice - marketPrice);
			} else {
				// PartyA loses - negative effect on balance
				pnlRate = -int256(marketPrice - closedPrice);
			}
		} else {
			// SHORT position
			if (closedPrice <= marketPrice) {
				// PartyA profits - positive effect on balance
				pnlRate = int256(marketPrice - closedPrice);
			} else {
				// PartyA loses - negative effect on balance
				pnlRate = -int256(closedPrice - marketPrice);
			}
		}

		// Total rate = unlockRate + pnlRate - feeRate (all scaled by 1e18 relative to close amount)
		// Note: pnlRate is price difference per unit, unlockRate and feeRate are scaled by 1e18
		int256 totalRate = int256(unlockRate) + pnlRate - int256(feeRate);

		// First check if full close (quantityToClose) keeps PartyA solvent
		int256 balanceAfterFullClose = currentBalance +
			int256((quote.quantityToClose * unlockRate) / 1e18) +
			(pnlRate * int256(quote.quantityToClose)) /
			1e18 -
			int256((quote.quantityToClose * feeRate) / 1e18);

		if (balanceAfterFullClose >= 0) {
			// Full close is safe
			return (quote.quantityToClose, true);
		}

		// Full close would make PartyA insolvent

		if (totalRate >= 0) {
			// Full close still leaves PartyA insolvent, and partial close cannot do better
			revert("LibSolvency: Full close keeps PartyA insolvent");
		}

		// totalRate < 0: Closing is HARMFUL - this is the partial close case
		// We need to limit how much we close to avoid making PartyA insolvent

		if (currentBalance <= 0) {
			// PartyA already insolvent, closing makes it worse
			// Can't close anything without making it worse
			return (0, false);
		}

		// currentBalance > 0, totalRate < 0
		// Find x such that: currentBalance + x * totalRate / 1e18 = 0
		// x = currentBalance * 1e18 / (-totalRate)
		//
		// Note: Integer division rounds DOWN intentionally. This is conservative:
		// - We close slightly less than what would bring balance to exactly 0
		// - Guarantees: currentBalance + (maxCloseAmount * totalRate / 1e18) >= 0
		maxCloseAmount = (uint256(currentBalance) * 1e18) / uint256(-totalRate);

		// Cap at quantityToClose (safety check, shouldn't be needed given balanceAfterFullClose < 0)
		if (maxCloseAmount > quote.quantityToClose) {
			maxCloseAmount = quote.quantityToClose;
		}

		return (maxCloseAmount, false);
	}
}
