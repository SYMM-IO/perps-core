// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Symbol, SymbolWithType } from "../../storages/SymbolStorage.sol";
import { FundingFee } from "../../storages/FundingStorage.sol";
import { SymbolAdjustment, RestatementPhase } from "../../storages/SymbolAdjustmentStorage.sol";
import { ISymbolAdjustmentFacet } from "../SymbolAdjustment/ISymbolAdjustmentFacet.sol";

struct PartyBSymbolCount {
	address partyB;
	uint256 symbolCount;
}

interface IViewFacetSymbol {
	function getSymbol(uint256 symbolId) external view returns (Symbol memory);

	function getSymbolWithType(uint256 symbolId) external view returns (SymbolWithType memory);

	function getSymbols(uint256 start, uint256 size) external view returns (Symbol[] memory);

	function getSymbolsWithType(uint256 start, uint256 size) external view returns (SymbolWithType[] memory);

	function getSymbolMinAcceptableNotionalLFRate(uint256 symbolId) external view returns (uint256 rate, bool hasOverride);

	function getPartyBLiquidationOvershootRate(address partyB, uint256 symbolId) external view returns (uint256 rate, bool hasOverride);

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

	function getConnectedPartyBsWithSymbolCounts(address partyA) external view returns (PartyBSymbolCount[] memory);

	function getSymbolAdjustment(uint256 symbolId) external view returns (SymbolAdjustment memory);

	function getCumulativeFactor(uint256 symbolId) external view returns (uint256);

	function getProspectiveCumulativeFactor(uint256 symbolId) external view returns (uint256);

	function previewQuoteAdjustment(
		uint256 symbolId,
		uint256 quoteId
	) external view returns (ISymbolAdjustmentFacet.QuoteAdjustmentPreview memory preview);

	function isSymbolFrozen(uint256 symbolId) external view returns (bool);

	function getRestatementState(uint256 symbolId) external view returns (bool restating, uint256 epoch);

	function getRestatementFundingProgress(
		uint256 symbolId
	) external view returns (RestatementPhase phase, uint256 pendingPartyBCount, uint256 fundingCutoffTimestamp, uint256 fundingRestorationTimestamp);

	function isRestatementFundingCheckpointed(uint256 symbolId, address partyB) external view returns (bool);

	function getQuoteRestatedEpoch(uint256 quoteId) external view returns (uint256);

	function getQuoteFundingSettledEpoch(uint256 quoteId) external view returns (uint256);

	function getRestatementFundingSettlementProgress(
		uint256 symbolId
	) external view returns (uint256 epoch, bool fundingSettlementRequired, uint256 remainingLong, uint256 remainingShort);

	function getRestatementInventoryProgress(
		uint256 symbolId,
		address partyB
	)
		external
		view
		returns (
			uint256 epoch,
			bool prepared,
			uint256 partyBRemainingLong,
			uint256 partyBRemainingShort,
			uint256 totalRemainingLong,
			uint256 totalRemainingShort
		);
}
