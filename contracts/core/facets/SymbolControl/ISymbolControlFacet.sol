// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IControlEvents } from "../Control/IControlEvents.sol";
import { Symbol, SymbolWithType } from "../../storages/SymbolStorage.sol";

interface ISymbolControlFacet is IControlEvents {
	function addSymbol(
		string memory name,
		uint256 minAcceptableQuoteValue,
		uint256 minAcceptablePortionLF,
		uint256 tradingFee,
		uint256 maxLeverage,
		uint256 fundingRateEpochDuration,
		uint256 fundingRateWindowTime
	) external;

	function addSymbols(Symbol[] memory symbols) external;

	function addSymbolsWithType(SymbolWithType[] memory symbolsWithType) external;

	function setSymbolFundingState(uint256 symbolId, uint256 fundingRateEpochDuration, uint256 fundingRateWindowTime) external;

	function setSymbolValidationState(uint256 symbolId, bool isValid) external;

	function setSymbolMaxLeverage(uint256 symbolId, uint256 maxLeverage) external;

	function setSymbolAcceptableValues(uint256 symbolId, uint256 minAcceptableQuoteValue, uint256 minAcceptablePortionLF) external;

	function setSymbolMinAcceptableNotionalLFRate(uint256 symbolId, uint256 minAcceptableNotionalLFRate) external;

	function clearSymbolMinAcceptableNotionalLFRateOverride(uint256 symbolId) external;

	function setPartyBLiquidationCushionRate(address partyB, uint256 symbolId, uint256 rate) external;

	function clearPartyBLiquidationCushionRateOverride(address partyB, uint256 symbolId) external;

	function setSymbolTradingFee(uint256 symbolId, uint256 tradingFee) external;

	function setSymbolTypes(uint256[] calldata symbolIds, uint256[] calldata symbolTypes) external;

	function whitelistSymbolType(address partyB, uint256 symbolType) external;

	function whitelistSymbols(address partyB, uint256[] calldata symbolIds) external;

	function removeSymbolTypeFromWhitelist(address partyB, uint256 symbolType) external;

	function removeSymbolsFromWhitelist(address partyB, uint256[] calldata symbolIds) external;

	function blacklistSymbols(address partyB, uint256[] calldata symbolIds) external;

	function removeSymbolsFromBlacklist(address partyB, uint256[] calldata symbolIds) external;
}
