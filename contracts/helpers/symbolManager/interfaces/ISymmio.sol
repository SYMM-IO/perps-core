// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Minimal interface the SymmioSymbolManager uses to call into the Symmio Diamond.
/// @dev Struct layouts mirror contracts/core/storages/SymbolStorage.sol and must stay in sync.
interface ISymmio {
	struct Symbol {
		uint256 symbolId;
		string name;
		bool isValid;
		uint256 minAcceptableQuoteValue;
		uint256 minAcceptablePortionLF;
		uint256 tradingFee;
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
		uint256 tradingFee;
		uint256 maxLeverage;
		uint256 fundingRateEpochDuration;
		uint256 fundingRateWindowTime;
		uint256 symbolType;
	}

	function addSymbols(Symbol[] memory symbols) external;

	function addSymbolsWithType(SymbolWithType[] memory symbolsWithType) external;

	function setSymbolTradingFee(uint256 symbolId, uint256 tradingFee) external;

	function setSymbolValidationState(uint256 symbolId, bool isValid) external;

	function setSymbolMaxLeverage(uint256 symbolId, uint256 maxLeverage) external;

	function setSymbolAcceptableValues(uint256 symbolId, uint256 minAcceptableQuoteValue, uint256 minAcceptablePortionLF) external;

	function setSymbolMinAcceptableNotionalLFRate(uint256 symbolId, uint256 minAcceptableNotionalLFRate) external;

	function clearSymbolMinAcceptableNotionalLFRateOverride(uint256 symbolId) external;

	function getSymbolMinAcceptableNotionalLFRate(uint256 symbolId) external view returns (uint256 rate, bool hasOverride);

	function setSymbolFundingState(uint256 symbolId, uint256 fundingRateEpochDuration, uint256 fundingRateWindowTime) external;

	function setForceCloseGapRatio(uint256 symbolId, uint256 _forceCloseGapRatio) external;

	function forceCloseGapRatio(uint256 symbolId) external view returns (uint256);

	function getSymbol(uint256 symbolId) external view returns (Symbol memory);

	function getSymbols(uint256 start, uint256 size) external view returns (Symbol[] memory);
}
