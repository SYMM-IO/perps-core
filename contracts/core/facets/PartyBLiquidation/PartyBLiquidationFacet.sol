// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Pausable } from "../../utils/Pausable.sol";
import { Accessibility, LibAccessibility } from "../../utils/Accessibility.sol";
import { IPartyBLiquidationFacet } from "./IPartyBLiquidationFacet.sol";
import { PartyBLiquidationFacetImpl } from "./PartyBLiquidationFacetImpl.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { SingleUpnlSig, QuotePriceSig } from "../../storages/MuonStorage.sol";

contract PartyBLiquidationFacet is Pausable, Accessibility, IPartyBLiquidationFacet {
	/**
	 * @notice Liquidates Party B with respect to a Party A.
	 * @param partyB The address of Party B to be liquidated.
	 * @param partyA The address of Party A related to the liquidation.
	 * @param upnlSig The Muon signature containing the unrealized profit and loss data.
	 */
	function liquidatePartyB(
		address partyB,
		address partyA,
		SingleUpnlSig memory upnlSig
	)
		external
		whenNotLiquidationPaused
		notLiquidatedPartyB(partyB, partyA)
		notCrossLiquidatedPartyB(partyB)
		notLiquidatedPartyA(partyA)
		onlyRole(LibAccessibility.PARTYB_LIQUIDATOR_ROLE)
	{
		emit LiquidatePartyB(msg.sender, partyB, partyA, AccountStorage.layout().partyBAllocatedBalances[partyB][partyA], upnlSig.upnl);
		PartyBLiquidationFacetImpl.liquidatePartyB(partyB, partyA, upnlSig);
	}

	/**
	 * @notice Liquidates positions of Party B the Party A.
	 * @param partyB The address of Party B whose positions are being liquidated.
	 * @param partyA The address of Party A related to the liquidation.
	 * @param priceSig The Muon signature containing the quote price data.
	 */
	function liquidatePositionsPartyB(
		address partyB,
		address partyA,
		QuotePriceSig memory priceSig
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.PARTYB_LIQUIDATOR_ROLE) {
		(uint256[] memory liquidatedAmounts, uint256[] memory closeIds, uint256[] memory averageClosedPrices) = PartyBLiquidationFacetImpl
			.liquidatePositionsPartyB(partyB, partyA, priceSig);
		emit LiquidatePositionsPartyB(msg.sender, partyB, partyA, priceSig.quoteIds, liquidatedAmounts, closeIds);
		emit LiquidatePositionsPartyB(msg.sender, partyB, partyA, priceSig.quoteIds, liquidatedAmounts, closeIds, averageClosedPrices);
		if (QuoteStorage.layout().partyBPositionsCount[partyB][partyA] == 0) {
			emit FullyLiquidatedPartyB(partyB, partyA);
		}
	}
}
