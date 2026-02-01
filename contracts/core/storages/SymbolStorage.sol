// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

struct Symbol {
	uint256 symbolId;
	string name;
	bool isValid;
	uint256 minAcceptableQuoteValue;
	uint256 minAcceptablePortionLF;
	uint256 tradingFee; // default Fee
	uint256 maxLeverage;
	uint256 fundingRateEpochDuration;
	uint256 fundingRateWindowTime;
}

struct SymbolWithType {
	uint256 symbolId;
	string name;
	bool isValid;
	uint256 minAcceptableQuoteValue;
	uint256 minAcceptablePortionLF;
	uint256 tradingFee; //default fee
	uint256 maxLeverage;
	uint256 fundingRateEpochDuration;
	uint256 fundingRateWindowTime;
	uint256 symbolType;
}

/// @title SymbolStorage
/// @notice Symbol configurations, funding rates, and market categorization
library SymbolStorage {
	bytes32 internal constant SYMBOL_STORAGE_SLOT = keccak256("diamond.standard.storage.symbol");

	struct Layout {
		/// @notice Symbol configuration by ID
		/// @dev Contains all trading rules for each symbol: fees, leverage, funding timing.
		///      Symbol IDs are sequential starting from 1 (ID 0 is invalid/unused).
		mapping(uint256 => Symbol) symbols;
		/// @notice Auto-incrementing counter for symbol IDs
		/// @dev New symbols get lastId + 1. Never decreases.
		uint256 lastId;
		/// @notice Price threshold percentage for force close validation per symbol (18 decimals)
		/// @dev For LONG: sig.highest >= requestedClosePrice * (1 + gapRatio).
		///      For SHORT: sig.lowest <= requestedClosePrice * (1 - gapRatio).
		///      Ensures price genuinely exceeded the threshold accounting for volatility.
		mapping(uint256 => uint256) forceCloseGapRatio;
		/// @notice Market category per symbol (e.g., 1 = crypto, 2 = forex)
		/// @dev Used with PartyB symbol type whitelisting to restrict which markets
		///      each hedger want to have exposure too.
		mapping(uint256 => uint256) symbolTypes;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = SYMBOL_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
