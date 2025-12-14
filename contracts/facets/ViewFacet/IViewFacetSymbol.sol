// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../storages/SymbolStorage.sol";

interface IViewFacetSymbol {
	function getSymbol(uint256 symbolId) external view returns (Symbol memory);

	function getSymbolWithType(uint256 symbolId) external view returns (SymbolWithType memory);

	function getSymbols(uint256 start, uint256 size) external view returns (Symbol[] memory);

	function getSymbolsWithType(uint256 start, uint256 size) external view returns (SymbolWithType[] memory);

	function getConnectedPartyBs(address partyA) external view returns (address[] memory);

	function isConnectedPartyB(address partyA, address partyB) external view returns (bool);

	function getAllowedSymbolsForPartyA(address partyA, uint256 start, uint256 size) external view returns (Symbol[] memory);

	function getAllowedSymbolsWithTypeForPartyA(address partyA, uint256 start, uint256 size) external view returns (SymbolWithType[] memory);

	function symbolsByQuoteId(uint256[] memory quoteIds) external view returns (Symbol[] memory);

	function symbolNameByQuoteId(uint256[] memory quoteIds) external view returns (string[] memory);

	function symbolNameById(uint256[] memory symbolIds) external view returns (string[] memory);

	function isWhitelistedSymbolType(address partyB, uint256 symbolType) external view returns (bool);

	function forceCloseGapRatio(uint256 symbolId) external view returns (uint256);

	function getFundingFeesOfPartyB(uint256 symbolId, address partyB) external view returns (FundingFee memory);

	function getAccumulatedFundingFees(uint256[] memory quoteIds) external view returns (int256[] memory fees);

	function getSumAccumulatedFundingFees(uint256[] memory quoteIds) external view returns (int256 sum);
}
