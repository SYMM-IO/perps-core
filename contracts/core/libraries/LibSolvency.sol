// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { QuoteStorage, Quote, LockedValues, PositionType } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibLiquidationOvershoot } from "./LibLiquidationOvershoot.sol";
import { LibQuote } from "./LibQuote.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";

library LibSolvency {
	using LockedValuesOps for LockedValues;

	struct CloseToLiquidationInputs {
		uint256 closedPrice;
		uint256 marketPrice;
		int256 upnlPartyA;
		/// @dev The most the solver fee can total; the charge is pro-rated as `maxSolverFee * filledAmount / maxFillAmount`.
		uint256 maxSolverFee;
		/// @dev The caller's close ceiling. It bounds the boundary search and is the quantity `maxSolverFee` is quoted for.
		///      Fee-less callers with no cap pass `type(uint256).max`; `quantityToClose` still bounds the search.
		uint256 maxFillAmount;
		uint256 overshootRate;
	}

	/// @notice Reverts unless both parties (Party A and Party B) remain solvent after opening positions for given quotes.
	/// @param quoteIds The IDs of the quotes for which the positions are being opened.
	/// @param filledAmounts The amounts of the quotes that will be filled by opening the positions.
	/// @param marketPrices The market prices of positions that will be opened.
	/// @param upnlPartyB The upnl of partyB
	/// @param upnlPartyA The upnl of partyA
	/// @param partyB Address of partyB
	/// @param partyA Address of partyA
	function requireSolventAfterOpenPosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory marketPrices,
		int256 upnlPartyB,
		int256 upnlPartyA,
		address partyB,
		address partyA
	) internal view {
		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = getAvailableBalanceAfterOpenPosition(
			quoteIds,
			filledAmounts,
			marketPrices,
			upnlPartyB,
			upnlPartyA,
			partyB,
			partyA
		);
		require(partyBAvailableBalance >= 0 && partyAAvailableBalance >= 0, "LibSolvency: Available balance is lower than zero");
	}

	/// @notice Calculates the available balances for Party A and Party B after opening positions for given quotes.
	/// @param quoteIds The IDs of the quotes for which the positions are being opened.
	/// @param filledAmounts The amounts of the quotes that will be filled by opening the positions.
	/// @param marketPrices The market prices of positions that will be opened.
	/// @param upnlPartyB The upnl of partyB
	/// @param upnlPartyA The upnl of partyA
	/// @param partyB Address of partyB
	/// @param partyA Address of partyA
	/// @return partyBAvailableBalance The available balance for Party B after opening the positions.
	/// @return partyAAvailableBalance The available balance for Party A after opening the positions.
	function getAvailableBalanceAfterOpenPosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
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
	}

	/// @notice Calculates the available balances for Party A and Party B after closing positions for given quotes.
	/// @param quoteIds The IDs of the quotes for which the positions are being closed.
	/// @param filledAmounts The amounts of the quotes that will be filled by closing the positions.
	/// @param closedPrices The prices at which the positions will be closed.
	/// @param marketPrices The market prices of positions that will be closed.
	/// @param upnlPartyB The upnl of partyB
	/// @param upnlPartyA The upnl of partyA
	/// @param partyB Address of partyB
	/// @param partyA Address of partyA
	/// @return partyBAvailableBalance The available balance for Party B after closing the positions.
	/// @return partyAAvailableBalance The available balance for Party A after closing the positions.
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
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			uint256 unlockedAmount =
				Math.mulDiv(filledAmount, quote.lockedValues.cva, openAmount) + Math.mulDiv(filledAmount, quote.lockedValues.lf, openAmount);

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

	/// @notice Reverts unless both parties (Party A and Party B) remain solvent after closing positions for given quotes.
	/// @param quoteIds The IDs of the quotes for which the positions are being closed.
	/// @param filledAmounts The amounts of the quotes that will be filled by closing the positions.
	/// @param closedPrices The prices at which the positions will be closed.
	/// @param marketPrices The market prices of positions that will be closed.
	/// @param upnlPartyB The upnl of partyB
	/// @param upnlPartyA The upnl of partyA
	/// @param partyB Address of partyB
	/// @param partyA Address of partyA
	function requireSolventAfterClosePosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		uint256[] memory marketPrices,
		int256 upnlPartyB,
		int256 upnlPartyA,
		address partyB,
		address partyA
	) internal view {
		requireSolventAfterClosePosition(quoteIds, filledAmounts, closedPrices, marketPrices, upnlPartyB, upnlPartyA, partyB, partyA, 0);
	}

	/// @notice Reverts unless PartyB remains solvent and PartyA stays within an explicitly calculated shortfall allowance.
	/// @dev Only close-to-liquidation callers pass a nonzero allowance. Every normal close uses the zero-defaulting overload.
	function requireSolventAfterClosePosition(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		uint256[] memory marketPrices,
		int256 upnlPartyB,
		int256 upnlPartyA,
		address partyB,
		address partyA,
		uint256 allowedPartyAShortfall
	) internal view returns (int256 partyAAvailableBalance) {
		int256 partyBAvailableBalance;
		(partyBAvailableBalance, partyAAvailableBalance) = getAvailableBalanceAfterClosePosition(
			quoteIds,
			filledAmounts,
			closedPrices,
			marketPrices,
			upnlPartyB,
			upnlPartyA,
			partyB,
			partyA
		);
		require(partyBAvailableBalance >= 0, "LibSolvency: Available balance is lower than zero");
		require(
			partyAAvailableBalance >= 0 || negativeMagnitude(partyAAvailableBalance) <= allowedPartyAShortfall,
			"LibSolvency: Available balance is lower than zero"
		);
		return partyAAvailableBalance;
	}

	/// @notice Calculates a close amount at PartyA's configured post-close shortfall boundary.
	/// @dev For a candidate amount `x`, the exact acceptance rule is:
	///      `postCloseBalance(x) >= -allowedShortfall(x)`, where
	///      `postCloseBalance = currentBalance + releasedCVA + releasedLF + PnL - closeFee - proratedSolverFee`
	///      and `allowedShortfall = postCloseAccountLockedCVAAndLF * overshootRate / 1e18`.
	///
	///      The allowance shrinks as this quote releases CVA and LF. The charged solver fee also changes with `x` because execution
	///      charges `floor(maxSolverFee * x / maxFillAmount)`. Before integer rounding, all of those changes are proportional
	///      to `x`, so the overshoot boundary is solved directly from the headroom at zero and the deficit at the upper bound.
	///      The resulting amount is then checked with execution's exact component-wise rounding and reduced algebraically if necessary.
	///      Therefore, it is exact for the proportional model and proven executable after rounding; separate floor operations can make it
	///      conservatively lower by a few smallest quantity units rather than allowing a shortfall above the configured allowance.
	///      The zero-overshoot, fee-less path keeps the legacy closed-form estimate and the same exact-rounding correction.
	///
	///      The search runs over `[0, min(maxFillAmount, quantityToClose)]`, so a caller cap that fits the allowance returns
	///      immediately without solving for the protocol boundary above it.
	///      A close of the whole bounded amount is accepted when it fits the allowance. With a nonzero overshoot, this can leave
	///      PartyA below zero.
	/// @param quoteId Quote whose pending close amount, together with `inputs.maxFillAmount`, bounds the calculation.
	/// @param inputs Price snapshot, PartyA uPnL, solver-fee terms, the caller's close ceiling, and the overshoot rate.
	/// @return maxCloseAmount Calculated boundary amount within the bound, before the planner's remaining-value fallback.
	/// @return canCloseAll Whether the whole bounded amount fits the allowance, not whether PartyA remains nonnegative.
	function calculateMaxCloseAmountToLiquidation(
		uint256 quoteId,
		CloseToLiquidationInputs memory inputs
	) internal view returns (uint256 maxCloseAmount, bool canCloseAll) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		require(openAmount > 0, "LibSolvency: No open amount");
		require(inputs.maxSolverFee == 0 || inputs.maxFillAmount > 0, "LibSolvency: Invalid solver fee basis");

		int256 currentBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			inputs.upnlPartyA,
			AccountStorage.layout().allocatedBalances[quote.partyA],
			quote.partyA
		);
		int256 pnlRate = _partyAPnlRate(quote.positionType, inputs.closedPrice, inputs.marketPrice);
		uint256 unlockRate = Math.mulDiv(quote.lockedValues.cva + quote.lockedValues.lf, 1e18, openAmount);
		uint256 feeRate = Math.mulDiv(inputs.closedPrice, quote.closeFee, 1e18, Math.Rounding.Up);
		uint256 solverFeeRate = inputs.maxSolverFee == 0 ? 0 : Math.mulDiv(inputs.maxSolverFee, 1e18, inputs.maxFillAmount, Math.Rounding.Up);
		// This rate classifies the close and supports the legacy formula. Candidate acceptance always uses the exact balance simulation.
		int256 totalRate = int256(unlockRate) + pnlRate - int256(feeRate) - int256(solverFeeRate);

		// The search space is bounded by both limits at once: a fill can never exceed the pending request, and the caller
		// never executes more than its own `maxFillAmount`. Solving above either would compute an amount nothing can use.
		uint256 upperBound = Math.min(quote.quantityToClose, inputs.maxFillAmount);

		// Check the whole bounded amount first. No search is needed when it is solvent or its shortfall fits the configured allowance.
		int256 balanceAtUpperBound = _simulatePartyAAvailableBalanceAfterClose(quote, upperBound, currentBalance, inputs);
		if (balanceAtUpperBound >= 0) return (upperBound, true);

		// If closing is non-harmful but the bounded close is still insolvent, reducing the amount cannot restore solvency.
		require(totalRate < 0, "LibSolvency: Full close keeps PartyA insolvent");
		// Preserve the existing policy for a shortfall that existed before a harmful close: do not deepen it through this helper.
		if (currentBalance <= 0) return (0, false);

		uint256 upperBoundAllowance = LibLiquidationOvershoot.allowedShortfallAfterClose(quote, upperBound, inputs.overshootRate);
		if (_isWithinPartyAShortfall(balanceAtUpperBound, upperBoundAllowance)) return (upperBound, true);

		uint256 harmfulRate = uint256(-totalRate);
		// The unrounded balance-plus-allowance model is linear in the close amount. Solve its boundary directly, then enforce exact rounding.
		if (inputs.overshootRate > 0 || inputs.maxSolverFee > 0) {
			return (_calculateOvershootCloseAmount(quote, upperBound, currentBalance, balanceAtUpperBound, upperBoundAllowance, inputs), false);
		}

		// Retain the legacy zero-rate, fee-less estimate. The exact check below repairs any component-rounding difference.
		maxCloseAmount = Math.mulDiv(uint256(currentBalance), 1e18, harmfulRate);
		if (maxCloseAmount > upperBound) maxCloseAmount = upperBound;
		int256 candidateBalance = _simulatePartyAAvailableBalanceAfterClose(quote, maxCloseAmount, currentBalance, inputs);

		if (candidateBalance < 0) {
			// Settlement floors CVA and LF releases separately, while `unlockRate` is combined. Back off enough to clear that difference.
			uint256 shortfall = negativeMagnitude(candidateBalance);
			uint256 reduction = Math.mulDiv(shortfall, 1e18, harmfulRate, Math.Rounding.Up);
			maxCloseAmount = reduction >= maxCloseAmount ? 0 : maxCloseAmount - reduction;
			if (!_isWithinPartyAShortfall(_simulatePartyAAvailableBalanceAfterClose(quote, maxCloseAmount, currentBalance, inputs), 0))
				return (0, false);
		}

		return (maxCloseAmount, false);
	}

	/// @dev Solves the proportional balance-plus-allowance equation without scanning quantity space.
	///      Integer floors can put the first candidate just beyond the executable boundary, so an invalid candidate is fed back into the
	///      same equation over the smaller `[0, candidate]` interval. This preserves execution rounding without assuming that every larger
	///      integer quantity must also be invalid.
	function _calculateOvershootCloseAmount(
		Quote storage quote,
		uint256 upperBound,
		int256 currentBalance,
		int256 balanceAtUpperBound,
		uint256 upperBoundAllowance,
		CloseToLiquidationInputs memory inputs
	) private view returns (uint256 candidateAmount) {
		uint256 startingAllowance = LibLiquidationOvershoot.allowedShortfallAfterClose(quote, 0, inputs.overshootRate);
		uint256 startingHeadroom = uint256(currentBalance) + startingAllowance;
		uint256 upperBoundDeficit = _partyAShortfallBeyondAllowance(balanceAtUpperBound, upperBoundAllowance);

		// For a linear model, x = upperBound * headroom / (headroom + upperBoundDeficit).
		candidateAmount = _proportionalBoundary(upperBound, startingHeadroom, upperBoundDeficit);
		while (true) {
			int256 candidateBalance = _simulatePartyAAvailableBalanceAfterClose(quote, candidateAmount, currentBalance, inputs);
			uint256 candidateAllowance = LibLiquidationOvershoot.allowedShortfallAfterClose(quote, candidateAmount, inputs.overshootRate);
			uint256 candidateDeficit = _partyAShortfallBeyondAllowance(candidateBalance, candidateAllowance);
			if (candidateDeficit == 0) return candidateAmount;

			// Re-solve on the smaller interval using the measured deficit. Force progress if ratio rounding returns the same quantity.
			uint256 correctedAmount = _proportionalBoundary(candidateAmount, startingHeadroom, candidateDeficit);
			candidateAmount = correctedAmount < candidateAmount ? correctedAmount : candidateAmount - 1;
		}
	}

	/// @dev Returns `upperBound * headroom / (headroom + deficit)` while keeping the denominator representable.
	///      On the overflow branch, headroom rounds down and deficit rounds up, so the returned close amount remains conservative.
	function _proportionalBoundary(uint256 upperBound, uint256 headroom, uint256 deficit) private pure returns (uint256) {
		if (headroom > type(uint256).max - deficit) {
			headroom >>= 1;
			deficit = (deficit >> 1) + (deficit & 1);
		}
		return Math.mulDiv(upperBound, headroom, headroom + deficit);
	}

	/// @dev Mirrors execution rounding: CVA and LF unlock separately, and the solver fee is floored after proration.
	function _simulatePartyAAvailableBalanceAfterClose(
		Quote storage quote,
		uint256 filledAmount,
		int256 currentBalance,
		CloseToLiquidationInputs memory inputs
	) private view returns (int256 balance) {
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		uint256 unlockedAmount =
			Math.mulDiv(filledAmount, quote.lockedValues.cva, openAmount) + Math.mulDiv(filledAmount, quote.lockedValues.lf, openAmount);
		uint256 closeFee = (filledAmount * inputs.closedPrice * quote.closeFee) / 1e36;
		int256 pnlRate = _partyAPnlRate(quote.positionType, inputs.closedPrice, inputs.marketPrice);

		uint256 chargedSolverFee = inputs.maxSolverFee == 0 ? 0 : Math.mulDiv(inputs.maxSolverFee, filledAmount, inputs.maxFillAmount);
		balance = currentBalance + int256(unlockedAmount) - int256(closeFee) - int256(chargedSolverFee);
		uint256 pnl = Math.mulDiv(filledAmount, pnlRate >= 0 ? uint256(pnlRate) : uint256(-pnlRate), 1e18);
		balance = pnlRate >= 0 ? balance + int256(pnl) : balance - int256(pnl);
	}

	function _partyAPnlRate(PositionType positionType, uint256 closedPrice, uint256 marketPrice) private pure returns (int256) {
		if (positionType == PositionType.LONG) {
			return closedPrice >= marketPrice ? int256(closedPrice - marketPrice) : -int256(marketPrice - closedPrice);
		}
		return closedPrice <= marketPrice ? int256(marketPrice - closedPrice) : -int256(closedPrice - marketPrice);
	}

	function _isWithinPartyAShortfall(int256 balance, uint256 allowedShortfall) private pure returns (bool) {
		return balance >= 0 || negativeMagnitude(balance) <= allowedShortfall;
	}

	function _partyAShortfallBeyondAllowance(int256 balance, uint256 allowedShortfall) private pure returns (uint256) {
		if (balance >= 0) return 0;
		uint256 shortfall = negativeMagnitude(balance);
		return shortfall > allowedShortfall ? shortfall - allowedShortfall : 0;
	}

	/// @notice Returns the magnitude of a negative value, valid for the full int256 range including type(int256).min.
	function negativeMagnitude(int256 value) internal pure returns (uint256) {
		return uint256(-(value + 1)) + 1;
	}
}
