// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";

/// @title LibSymbol
/// @notice Resolves inherited symbol configuration and computes symbol-level requirements.
library LibSymbol {
	/// @notice Returns the effective minimum LF rate against notional for a symbol.
	/// @dev Symbol 0 is the default. Explicit nonzero overrides, including an override of zero, take precedence.
	function minAcceptableNotionalLFRate(uint256 symbolId) internal view returns (uint256) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolId != 0 && symbolLayout.hasMinAcceptableNotionalLFRateOverride[symbolId]) {
			return symbolLayout.minAcceptableNotionalLFRates[symbolId];
		}
		return symbolLayout.minAcceptableNotionalLFRates[0];
	}

	/// @notice Returns whether a nonzero symbol has an explicit notional LF rate override.
	function hasMinAcceptableNotionalLFRateOverride(uint256 symbolId) internal view returns (bool) {
		return symbolId != 0 && SymbolStorage.layout().hasMinAcceptableNotionalLFRateOverride[symbolId];
	}

	/// @notice Computes the minimum LF for a quantity and price under the effective symbol rate.
	/// @dev Quantity and price use 1e18 precision. Both normalization steps round upward so the result
	///      never falls below the mathematically configured minimum because of integer division.
	function requiredNotionalLF(uint256 symbolId, uint256 quantity, uint256 price) internal view returns (uint256) {
		uint256 notional = Math.mulDiv(quantity, price, 1e18, Math.Rounding.Ceil);
		return Math.mulDiv(notional, minAcceptableNotionalLFRate(symbolId), 1e18, Math.Rounding.Ceil);
	}
}
