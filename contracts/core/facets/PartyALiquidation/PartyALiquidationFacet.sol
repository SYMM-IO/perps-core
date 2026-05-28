// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Pausable } from "../../utils/Pausable.sol";
import { Accessibility, LibAccessibility } from "../../utils/Accessibility.sol";
import { IPartyALiquidationFacet } from "./IPartyALiquidationFacet.sol";
import { LibPartyALiquidationLegacySetup } from "../../libraries/liquidation/LibPartyALiquidationLegacySetup.sol";
import { LibPartyALiquidationProcess } from "../../libraries/liquidation/LibPartyALiquidationProcess.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { LiquidationSig, DeferredLiquidationSig } from "../../storages/MuonStorage.sol";

contract PartyALiquidationFacet is Pausable, Accessibility, IPartyALiquidationFacet {
	/// @notice Starts the legacy live PartyA liquidation flow based on the provided signature.
	/// @param partyA The address of Party A to be liquidated.
	/// @param liquidationSig The Muon signature.
	function liquidatePartyA(
		address partyA,
		LiquidationSig memory liquidationSig
	) external whenNotLiquidationPaused notLiquidatedPartyA(partyA) onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationLegacySetup.liquidatePartyA(partyA, liquidationSig);
		emit LiquidatePartyA(
			msg.sender,
			partyA,
			AccountStorage.layout().allocatedBalances[partyA],
			liquidationSig.upnl,
			liquidationSig.totalUnrealizedLoss,
			liquidationSig.liquidationId
		);
	}

	/// @notice Sets legacy symbol prices for a PartyA liquidation.
	/// @dev The Muon signature's liquidationId must match the one from the initial liquidatePartyA call.
	/// @param partyA The address of Party A associated with the liquidation.
	/// @param liquidationSig The Muon signature containing symbol IDs and their corresponding prices.
	function setSymbolsPrice(
		address partyA,
		LiquidationSig memory liquidationSig
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationLegacySetup.setSymbolsPrice(partyA, liquidationSig);
		emit SetSymbolsPrices(msg.sender, partyA, liquidationSig.symbolIds, liquidationSig.prices, liquidationSig.liquidationId);
	}

	/// @notice Starts the legacy deferred PartyA liquidation flow based on the provided signature.
	/// @param partyA The address of Party A to be liquidated.
	/// @param liquidationSig The Muon signature.
	function deferredLiquidatePartyA(
		address partyA,
		DeferredLiquidationSig memory liquidationSig
	) external whenNotLiquidationPaused notLiquidatedPartyA(partyA) onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationLegacySetup.deferredLiquidatePartyA(partyA, liquidationSig);
		emit DeferredLiquidatePartyA(
			msg.sender,
			partyA,
			AccountStorage.layout().allocatedBalances[partyA],
			liquidationSig.upnl,
			liquidationSig.totalUnrealizedLoss,
			liquidationSig.liquidationId,
			liquidationSig.liquidationBlockNumber,
			liquidationSig.liquidationTimestamp,
			liquidationSig.liquidationAllocatedBalance
		);
	}

	/// @notice Sets legacy symbol prices for a deferred PartyA liquidation.
	/// @dev The Muon signature's liquidationId must match the one from the initial deferredLiquidatePartyA call.
	/// @param partyA The address of Party A associated with the liquidation.
	/// @param liquidationSig The Muon signature containing symbol IDs and their corresponding prices.
	function deferredSetSymbolsPrice(
		address partyA,
		DeferredLiquidationSig memory liquidationSig
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		LibPartyALiquidationLegacySetup.deferredSetSymbolsPrice(partyA, liquidationSig);
		emit SetSymbolsPrices(msg.sender, partyA, liquidationSig.symbolIds, liquidationSig.prices, liquidationSig.liquidationId);
	}

	/// @notice Liquidates pending positions of Party A.
	/// @param partyA The address of Party A whose pending positions will be liquidated.
	function liquidatePendingPositionsPartyA(address partyA) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256[] memory pendingQuotes = quoteLayout.partyAPendingQuotes[partyA];
		(uint256[] memory liquidatedAmounts, bytes memory liquidationId) = LibPartyALiquidationProcess.liquidatePendingPositionsPartyA(partyA);
		emit LiquidatePendingPositionsPartyA(msg.sender, partyA, pendingQuotes, liquidatedAmounts, liquidationId);
	}

	/// @notice Liquidates open positions of Party A.
	/// @param partyA The address of Party A whose positions will be liquidated.
	/// @param quoteIds An array of quote IDs representing the positions to be liquidated.
	function liquidatePositionsPartyA(
		address partyA,
		uint256[] memory quoteIds
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		(
			bool disputed,
			uint256[] memory liquidatedAmounts,
			uint256[] memory closeIds,
			uint256[] memory averageClosedPrices,
			bytes memory liquidationId
		) = LibPartyALiquidationProcess.liquidatePositionsPartyA(partyA, quoteIds);
		emit LiquidatePositionsPartyA(msg.sender, partyA, quoteIds, liquidatedAmounts, closeIds, liquidationId);
		emit LiquidatePositionsPartyA(msg.sender, partyA, quoteIds, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
		if (disputed) {
			emit LiquidationDisputed(partyA, liquidationId);
		}
	}

	/// @notice Settles liquidation for Party A with specified Party Bs.
	/// @param partyA The address of Party A to settle liquidation for.
	/// @param partyBs An array of addresses representing Party Bs involved in the settlement.
	function settlePartyALiquidation(address partyA, address[] memory partyBs) external whenNotLiquidationPaused {
		(int256[] memory settleAmounts, bytes memory liquidationId, bool fullySettled) = LibPartyALiquidationProcess.settlePartyALiquidation(
			partyA,
			partyBs
		);
		emit SettlePartyALiquidation(partyA, partyBs, settleAmounts, liquidationId);
		if (fullySettled) {
			emit FullyLiquidatedPartyA(partyA, liquidationId);
		}
	}

	/// @notice Resolves a liquidation dispute for Party A with specified Party Bs and settlement amounts.
	/// @param partyA The address of Party A involved in the dispute.
	/// @param partyBs An array of addresses representing Party Bs involved in the dispute.
	/// @param amounts An array of settlement amounts corresponding to Party Bs.
	/// @param disputed Whether the liquidation should remain in disputed state after resolution.
	function resolveLiquidationDispute(
		address partyA,
		address[] memory partyBs,
		int256[] memory amounts,
		bool disputed
	) external onlyRole(LibAccessibility.DISPUTE_ROLE) {
		bytes memory liquidationId = LibPartyALiquidationProcess.resolveLiquidationDispute(partyA, partyBs, amounts, disputed);
		emit ResolveLiquidationDispute(partyA, partyBs, amounts, disputed, liquidationId);
	}
}
