// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { AggregatedDataStorage } from "../../storages/AggregatedDataStorage.sol";
import { PartyBControlStorage } from "../../storages/PartyBControlStorage.sol";
import { FundingStorage, FundingFee } from "../../storages/FundingStorage.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { SymbolStorage, Symbol, SymbolWithType } from "../../storages/SymbolStorage.sol";
import {
	SymbolAdjustmentStorage,
	SymbolAdjustment,
	AdjustmentState,
	RestatementPhase,
	RestatementInventoryCheckpoint,
	RestatementInventoryTotals
} from "../../storages/SymbolAdjustmentStorage.sol";
import { IViewFacetSymbol, PartyBSymbolCount } from "./IViewFacetSymbol.sol";
import { ISymbolAdjustmentFacet } from "../SymbolAdjustment/ISymbolAdjustmentFacet.sol";
import { LibSymbol } from "../../libraries/LibSymbol.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";
import { LibQuoteAdjustment, QuoteAdjustmentData } from "../../libraries/LibQuoteAdjustment.sol";
import { LibLiquidationCushion } from "../../libraries/LibLiquidationCushion.sol";

contract ViewFacetSymbol is IViewFacetSymbol {
	/// @notice Returns the details of a symbol by its ID.
	/// @param symbolId The ID of the symbol.
	/// @return The details of the symbol.
	function getSymbol(uint256 symbolId) external view returns (Symbol memory) {
		return SymbolStorage.layout().symbols[symbolId];
	}

	/// @notice Converts a symbol to a symbol with type.
	/// @param symbol The symbol to convert.
	/// @param symbolType The type of the symbol.
	/// @return The symbol with type.
	function _toSymbolWithType(Symbol memory symbol, uint256 symbolType) internal pure returns (SymbolWithType memory) {
		return
			SymbolWithType(
				symbol.symbolId,
				symbol.name,
				symbol.isValid,
				symbol.minAcceptableQuoteValue,
				symbol.minAcceptablePortionLF,
				symbol.tradingFee,
				symbol.maxLeverage,
				symbol.fundingRateEpochDuration,
				symbol.fundingRateWindowTime,
				symbolType
			);
	}

	/// @notice Returns the details of a symbol along with its type.
	/// @param symbolId The ID of the symbol to retrieve.
	/// @return A SymbolWithType struct containing the symbol details and its type.
	function getSymbolWithType(uint256 symbolId) external view returns (SymbolWithType memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		Symbol memory symbol = symbolLayout.symbols[symbolId];

		return _toSymbolWithType(symbol, symbolLayout.symbolTypes[symbolId]);
	}

	/// @notice Returns an array of symbols starting from a specific index.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of symbols.
	function getSymbols(uint256 start, uint256 size) external view returns (Symbol[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();

		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}

		Symbol[] memory symbols = new Symbol[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			symbols[i - start] = symbolLayout.symbols[i + 1];
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/// @notice Returns an array of symbols with their types starting from a specific index.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of symbols with their types.
	function getSymbolsWithType(uint256 start, uint256 size) external view returns (SymbolWithType[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}
		SymbolWithType[] memory symbols = new SymbolWithType[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			Symbol memory symbol = symbolLayout.symbols[i + 1];
			symbols[i - start] = _toSymbolWithType(symbol, symbolLayout.symbolTypes[symbol.symbolId]);
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/// @notice Returns the effective notional LF rate and whether it is a symbol-specific override.
	/// @dev Symbol 0 returns the live default and always reports hasOverride as false.
	function getSymbolMinAcceptableNotionalLFRate(uint256 symbolId) external view returns (uint256 rate, bool hasOverride) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId <= symbolLayout.lastId, "ViewFacetSymbol: Invalid id");
		return (LibSymbol.minAcceptableNotionalLFRate(symbolId), LibSymbol.hasMinAcceptableNotionalLFRateOverride(symbolId));
	}

	/// @notice Returns a PartyB's effective close-to-liquidation cushion rate and override state.
	function getPartyBLiquidationCushionRate(address partyB, uint256 symbolId) external view returns (uint256 rate, bool hasOverride) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		require(symbolId <= symbolLayout.lastId, "ViewFacetSymbol: Invalid id");
		return (LibLiquidationCushion.rate(partyB, symbolId), LibLiquidationCushion.hasOverride(partyB, symbolId));
	}

	/// @notice Returns the connected party Bs of Party A.
	/// @param partyA The address of Party A.
	/// @return An array of connected party Bs.
	function getConnectedPartyBs(address partyA) external view returns (address[] memory) {
		return AccountStorage.layout().connectedPartyBs[partyA];
	}

	/// @notice Checks whether a specific partyB is connected to a partyA.
	/// @param partyA The address of Party A.
	/// @param partyB The address of Party B.
	/// @return True if partyB is connected to partyA, false otherwise.
	function isConnectedPartyB(address partyA, address partyB) external view returns (bool) {
		return AccountStorage.layout().isConnectedPartyB[partyA][partyB];
	}

	/// @notice Returns the allowed symbols of Party A.
	/// @param partyA The address of Party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of allowed symbols.
	function getAllowedSymbolsForPartyA(address partyA, uint256 start, uint256 size) external view returns (Symbol[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}
		Symbol[] memory symbols = new Symbol[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			Symbol memory symbol = symbolLayout.symbols[i + 1];
			if (LibConnections.isSymbolAllowedForPartyA(partyA, symbol.symbolId) && symbol.isValid) {
				symbols[i - start] = symbol;
			}
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/// @notice Returns an array of symbols with their types associated with a party A.
	/// @param partyA The address of Party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of symbols with their types.
	function getAllowedSymbolsWithTypeForPartyA(address partyA, uint256 start, uint256 size) external view returns (SymbolWithType[] memory) {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		if (symbolLayout.lastId < start + size) {
			size = symbolLayout.lastId - start;
		}
		SymbolWithType[] memory symbols = new SymbolWithType[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			Symbol memory symbol = symbolLayout.symbols[i + 1];
			if (LibConnections.isSymbolAllowedForPartyA(partyA, symbol.symbolId) && symbol.isValid) {
				symbols[i - start] = _toSymbolWithType(symbol, symbolLayout.symbolTypes[symbol.symbolId]);
			}
			unchecked {
				++i;
			}
		}
		return symbols;
	}

	/// @notice Returns an array of symbols associated with an array of quote IDs.
	/// @param quoteIds An array of quote IDs.
	/// @return An array of symbols.
	function symbolsByQuoteId(uint256[] memory quoteIds) external view returns (Symbol[] memory) {
		Symbol[] memory symbols = new Symbol[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			symbols[i] = SymbolStorage.layout().symbols[QuoteStorage.layout().quotes[quoteIds[i]].symbolId];
		}
		return symbols;
	}

	/// @notice Returns an array of symbol names associated with an array of quote IDs.
	/// @param quoteIds An array of quote IDs.
	/// @return An array of symbol names.
	function symbolNameByQuoteId(uint256[] memory quoteIds) external view returns (string[] memory) {
		string[] memory symbols = new string[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			symbols[i] = SymbolStorage.layout().symbols[QuoteStorage.layout().quotes[quoteIds[i]].symbolId].name;
		}
		return symbols;
	}

	/// @notice Returns an array of symbol names associated with an array of symbol IDs.
	/// @param symbolIds An array of symbol IDs.
	/// @return An array of symbol names.
	function symbolNameById(uint256[] memory symbolIds) external view returns (string[] memory) {
		string[] memory symbols = new string[](symbolIds.length);
		for (uint256 i = 0; i < symbolIds.length; i++) {
			symbols[i] = SymbolStorage.layout().symbols[symbolIds[i]].name;
		}
		return symbols;
	}

	/// @notice Checks if a symbol type is whitelisted for a party B.
	/// @param partyB The address of party B.
	/// @param symbolType The type of the symbol.
	/// @return A boolean indicating whether the symbol type is whitelisted for the party B.
	function isWhitelistedSymbolType(address partyB, uint256 symbolType) external view returns (bool) {
		return PartyBControlStorage.layout().partyBWhitelistedSymbolTypes[partyB][symbolType];
	}

	/// @notice Returns the force close gap ratio.
	/// @param symbolId The symbolId that this ratio is for.
	/// @return The force close gap ratio.
	function forceCloseGapRatio(uint256 symbolId) external view returns (uint256) {
		return SymbolStorage.layout().forceCloseGapRatio[symbolId];
	}

	/// @notice Retrieves the funding fee structure of a party B for a specific symbol.
	/// @param symbolId The ID of the symbol.
	/// @param partyB The address of the party B.
	/// @return fundingFee The funding fee structure of the party B.
	function getFundingFeesOfPartyB(uint256 symbolId, address partyB) external view returns (FundingFee memory) {
		return FundingStorage.layout().fundingFees[symbolId][partyB];
	}

	/// @notice Returns all connected PartyBs for a PartyA with the count of unique symbols
	///         that have active positions for each PartyB.
	/// @param partyA The address of Party A.
	/// @return An array of PartyBSymbolCount structs containing partyB address and symbol count.
	function getConnectedPartyBsWithSymbolCounts(address partyA) external view returns (PartyBSymbolCount[] memory) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		AggregatedDataStorage.Layout storage aggregatedLayout = AggregatedDataStorage.layout();

		address[] memory connectedPartyBs = accountLayout.connectedPartyBs[partyA];
		PartyBSymbolCount[] memory result = new PartyBSymbolCount[](connectedPartyBs.length);

		for (uint256 i = 0; i < connectedPartyBs.length;) {
			address partyB = connectedPartyBs[i];
			result[i] = PartyBSymbolCount({ partyB: partyB, symbolCount: aggregatedLayout.partyAActiveSymbolsPerPartyB[partyA][partyB].length });
			unchecked {
				++i;
			}
		}

		return result;
	}

	function getSymbolAdjustment(uint256 symbolId) external view returns (SymbolAdjustment memory) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId];
	}

	function getCumulativeFactor(uint256 symbolId) external view returns (uint256) {
		return LibSymbolAdjustment.activeCumulativeFactor(symbolId);
	}

	/// @notice Returns the factor that confirmation would activate or direct restatement would select for the current scheduled adjustment.
	/// @dev Muon uses this value only for the active-factor route; getCumulativeFactor intentionally returns only confirmed trading state.
	function getProspectiveCumulativeFactor(uint256 symbolId) external view returns (uint256) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		return _prospectiveCumulativeFactor(symbolId, adjustment);
	}

	/// @notice Previews every quote field using the open window, scheduled prospective, or confirmed active factor and reverts on unsafe rounding.
	function previewQuoteAdjustment(
		uint256 symbolId,
		uint256 quoteId
	) external view returns (ISymbolAdjustmentFacet.QuoteAdjustmentPreview memory preview) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.symbolId == symbolId, "ViewFacetSymbol: Wrong symbol");
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		uint256 factor =
			adjustment.restating
				? adjustment.restatementFactor
				: adjustment.state == AdjustmentState.SCHEDULED
					? _prospectiveCumulativeFactor(symbolId, adjustment)
					: LibSymbolAdjustment.activeCumulativeFactor(symbolId);
		require(factor != 0, "ViewFacetSymbol: Cumulative factor underflow");
		require(factor != 1e18, "ViewFacetSymbol: No adjustment factor");
		return _previewQuote(quote, factor);
	}

	function isSymbolFrozen(uint256 symbolId) external view returns (bool) {
		return LibSymbolAdjustment.isFrozen(symbolId);
	}

	function getRestatementState(uint256 symbolId) external view returns (bool restating, uint256 epoch) {
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		return (adjustment.restating, adjustment.restatementEpoch);
	}

	function getRestatementFundingProgress(
		uint256 symbolId
	)
		external
		view
		returns (RestatementPhase phase, uint256 pendingPartyBCount, uint256 fundingCutoffTimestamp, uint256 fundingRestorationTimestamp)
	{
		SymbolAdjustment storage adjustment = SymbolAdjustmentStorage.layout().adjustments[symbolId];
		return (
			adjustment.restatementPhase,
			adjustment.pendingFundingPartyBCount,
			adjustment.fundingCutoffTimestamp,
			adjustment.fundingRestorationTimestamp
		);
	}

	function isRestatementFundingCheckpointed(uint256 symbolId, address partyB) external view returns (bool) {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[symbolId];
		return adjustment.restating && adjustmentLayout.fundingRateCheckpoints[symbolId][partyB].restatementEpoch == adjustment.restatementEpoch;
	}

	function getQuoteRestatedEpoch(uint256 quoteId) external view returns (uint256) {
		return SymbolAdjustmentStorage.layout().quoteRestatedEpoch[quoteId];
	}

	/// @notice Returns the current restatement inventory for one PartyB and the symbol-wide remaining quantities.
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
		)
	{
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[symbolId];
		RestatementInventoryCheckpoint storage checkpoint = adjustmentLayout.restatementInventoryCheckpoints[symbolId][partyB];
		RestatementInventoryTotals storage totals = adjustmentLayout.restatementInventoryTotals[symbolId];
		epoch = adjustment.restatementEpoch;
		prepared = adjustment.restating && checkpoint.restatementEpoch == epoch;
		if (prepared) {
			partyBRemainingLong = checkpoint.remainingLong;
			partyBRemainingShort = checkpoint.remainingShort;
		}
		totalRemainingLong = totals.remainingLong;
		totalRemainingShort = totals.remainingShort;
	}

	function _prospectiveCumulativeFactor(uint256 symbolId, SymbolAdjustment storage adjustment) internal view returns (uint256) {
		uint256 activeFactor = LibSymbolAdjustment.activeCumulativeFactor(symbolId);
		if (adjustment.state != AdjustmentState.SCHEDULED) return activeFactor;
		return Math.mulDiv(activeFactor, adjustment.factor, 1e18);
	}

	function _previewQuote(Quote storage quote, uint256 factor) internal pure returns (ISymbolAdjustmentFacet.QuoteAdjustmentPreview memory preview) {
		Quote memory quoteSnapshot = quote;
		QuoteAdjustmentData memory result = LibQuoteAdjustment.preview(quoteSnapshot, factor);
		return
			ISymbolAdjustmentFacet.QuoteAdjustmentPreview({
				factor: result.factor,
				quantity: result.quantity,
				openedPrice: result.openedPrice,
				initialOpenedPrice: result.initialOpenedPrice,
				requestedOpenPrice: result.requestedOpenPrice,
				marketPrice: result.marketPrice,
				closedAmount: result.closedAmount,
				avgClosedPrice: result.avgClosedPrice,
				quantityToClose: result.quantityToClose,
				requestedClosePrice: result.requestedClosePrice
			});
	}
}
