// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ISettlementFacet } from "./ISettlementFacet.sol";
import { Accessibility, LibAccessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { SettlementFacetImpl } from "./SettlementFacetImpl.sol";
import { SettlementSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";

contract SettlementFacet is Accessibility, Pausable, ISettlementFacet {
	/// @notice Allows Party B to settle the upnl of party A position for the specified quotes.
	/// @param settlementSig The Muon settlement signature containing quoteIds, uPNL of both parties, and market prices.
	/// @param updatedPrices New prices to be set as openedPrice for the specified quotes.
	/// @param partyA Address of party A
	/// @dev DEPRECATED: This function is kept for backward compatibility. Use settleUpnlUnified instead,
	///      which supports both crossPartyB and normal partyB modes with a unified signature format.
	function settleUpnl(
		SettlementSig memory settlementSig,
		uint256[] memory updatedPrices,
		address partyA
	) external whenNotPartyBActionsPaused onlyPartyB notLiquidatedPartyA(partyA) {
		uint256[] memory newPartyBsAllocatedBalances = SettlementFacetImpl.settleUpnl(settlementSig, updatedPrices, partyA);
		emit SettleUpnl(
			settlementSig.quotesSettlementsData,
			updatedPrices,
			partyA,
			AccountStorage.layout().allocatedBalances[partyA],
			newPartyBsAllocatedBalances
		);
	}

	/// @notice Unified settlement function that works for both crossPartyB and normal partyB modes
	/// @dev Settles quotes for a single partyB across one or more partyAs
	/// @param sig The unified settlement signature containing quote data and UPNLs
	/// @param updatedPrices Array of new prices to set as openedPrice for each quote
	function settleUpnlUnified(UnifiedSettlementSig memory sig, uint256[] memory updatedPrices) external whenNotPartyBActionsPaused onlyPartyB {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		uint256[] memory newPartyAsAllocatedBalances = SettlementFacetImpl.settleUpnlUnified(sig, updatedPrices);

		// Get partyB allocated balance based on mode
		address allocKey = MAStorage.layout().crossModeEnabledForPartyB[sig.partyB] ? address(0) : sig.partyAs[0];
		uint256 newPartyBAllocatedBalance = accountLayout.partyBAllocatedBalances[sig.partyB][allocKey];

		emit SettleUpnlUnified(
			sig.reqId,
			sig.quotesSettlementsData,
			updatedPrices,
			sig.partyB,
			sig.partyAs,
			newPartyAsAllocatedBalances,
			newPartyBAllocatedBalance
		);
	}

	/// @notice Settles a cross-mode PartyB's uPNL from other solvent counterparties during PartyA liquidation.
	/// @dev Called by the liquidator between liquidatePositionsPartyA and settlePartyALiquidation to
	///      realize PartyB's unrealized profit into allocated balance, preventing settlement shortfalls.
	/// @param liquidatedPartyA The partyA currently being liquidated
	/// @param sig Unified settlement signature for the cross-mode partyB's positions with OTHER partyAs
	/// @param updatedPrices New opened prices for the settled quotes
	function settlePartyBUpnlForLiquidation(
		address liquidatedPartyA,
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.LIQUIDATOR_ROLE) {
		uint256[] memory newPartyAsAllocatedBalances = SettlementFacetImpl.settlePartyBUpnlForLiquidation(liquidatedPartyA, sig, updatedPrices);

		uint256 newPartyBAllocatedBalance = AccountStorage.layout().partyBAllocatedBalances[sig.partyB][address(0)];

		emit SettlePartyBUpnlForLiquidation(
			liquidatedPartyA,
			sig.partyB,
			sig.reqId,
			sig.quotesSettlementsData,
			updatedPrices,
			sig.partyAs,
			newPartyAsAllocatedBalances,
			newPartyBAllocatedBalance
		);
	}
}
