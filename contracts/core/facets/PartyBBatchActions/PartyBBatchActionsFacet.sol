// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PartyBBatchActionsFacetImpl } from "./PartyBBatchActionsFacetImpl.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IPartyBBatchActionsFacet } from "./IPartyBBatchActionsFacet.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { PairUpnlAndPricesSig } from "../../storages/MuonStorage.sol";
contract PartyBBatchActionsFacet is Accessibility, Pausable, IPartyBBatchActionsFacet {
	/// @notice Opens positions for the specified quotes in batch. The opened position's size can't be excessively small or large.
	/// @param quoteIds The IDs of the quotes for which the positions are opened.
	/// @param filledAmounts PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it
	/// @param openedPrices The opened prices for the positions.
	/// @param upnlSig The Muon signature containing PairUpnlAndPricesSig data.
	function openPositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory openedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external whenNotPartyBOpenPositionsPaused {
		PartyBBatchActionsFacetImpl.openPositions(quoteIds, filledAmounts, openedPrices, upnlSig);
	}

	/// @notice Fills the close request for the specified quotes in batch.
	/// @param quoteIds The IDs of the quotes for which the close request is filled.
	/// @param filledAmounts The filled amounts for the close requests. PartyB can fill LIMIT requests in multiple steps
	///                      and each within a different price but market requests should be filled all at once.
	/// @param closedPrices The closed prices for the close requests.
	/// @param upnlSig The Muon signature containing PairUpnlAndPricesSig data.
	function fillCloseRequests(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external whenNotPartyBActionsPaused {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		(QuoteStatus[] memory quoteStatuses, uint256[] memory closeIds) = PartyBBatchActionsFacetImpl.closePositions(
			quoteIds,
			filledAmounts,
			closedPrices,
			upnlSig
		);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			emit FillCloseRequest(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], closedPrices[i], quoteStatuses[i], closeIds[i]);
			emit FillCloseRequest(
				quoteIds[i],
				quote.partyA,
				quote.partyB,
				filledAmounts[i],
				closedPrices[i],
				quoteStatuses[i],
				closeIds[i],
				quote.lockedValues
			);
		}
	}
}
