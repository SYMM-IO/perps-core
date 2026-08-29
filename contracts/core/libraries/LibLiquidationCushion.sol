// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { LiquidationCushionStorage } from "../storages/LiquidationCushionStorage.sol";
import { Quote } from "../storages/QuoteStorage.sol";
import { LibQuote } from "./LibQuote.sol";

/// @title LibLiquidationCushion
/// @notice Resolves inherited cushion rates and computes account-level post-close allowances.
library LibLiquidationCushion {
	/// @notice Returns the effective cushion rate for a PartyB and symbol.
	function rate(address partyB, uint256 symbolId) internal view returns (uint256) {
		LiquidationCushionStorage.Layout storage cushionLayout = LiquidationCushionStorage.layout();
		if (symbolId != 0 && cushionLayout.hasOverride[partyB][symbolId]) {
			return cushionLayout.rates[partyB][symbolId];
		}
		return cushionLayout.rates[partyB][0];
	}

	/// @notice Returns whether a nonzero symbol has an explicit override for a PartyB.
	function hasOverride(address partyB, uint256 symbolId) internal view returns (bool) {
		return symbolId != 0 && LiquidationCushionStorage.layout().hasOverride[partyB][symbolId];
	}

	/// @notice Returns PartyA's remaining account-level CVA + LF after closing part of one quote.
	/// @dev Component-wise rounding matches LibQuoteClose._prepareCloseQuote.
	function postCloseThreshold(Quote storage quote, uint256 filledAmount) internal view returns (uint256) {
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		uint256 unlockedCva = Math.mulDiv(quote.lockedValues.cva, filledAmount, openAmount);
		uint256 unlockedLf = Math.mulDiv(quote.lockedValues.lf, filledAmount, openAmount);
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		uint256 currentThreshold = accountLayout.lockedBalances[quote.partyA].cva + accountLayout.lockedBalances[quote.partyA].lf;
		return currentThreshold - unlockedCva - unlockedLf;
	}

	/// @notice Computes the maximum PartyA shortfall for a threshold and 1e18 rate.
	/// @dev SymbolControlFacet caps stored rates at 1e18, so the result never exceeds the threshold.
	function allowedShortfall(uint256 threshold, uint256 cushionRate) internal pure returns (uint256) {
		return Math.mulDiv(threshold, cushionRate, 1e18);
	}

	/// @notice Returns the allowance after a candidate close using the effective PartyB-symbol rate.
	function allowedShortfallAfterClose(Quote storage quote, uint256 filledAmount, uint256 cushionRate) internal view returns (uint256) {
		return allowedShortfall(postCloseThreshold(quote, filledAmount), cushionRate);
	}
}
