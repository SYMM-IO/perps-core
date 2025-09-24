// contracts/facets/ADL/ADLFacetImpl.sol
// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../libraries/muon/LibMuonPartyB.sol";
import "../../libraries/muon/LibMuonPartyBBatchActions.sol";
import "../../libraries/LibSolvency.sol";
import "../../libraries/LibQuote.sol";
import "../../storages/MAStorage.sol";
import "../../storages/QuoteStorage.sol";
import "../../storages/AccountStorage.sol";
import "../../storages/SymbolStorage.sol";

library ADLFacetImpl {
	using LockedValuesOps for LockedValues;

	function adlClosePositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) internal returns (QuoteStatus[] memory) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		require(
			quoteIds.length == filledAmounts.length && quoteIds.length == closedPrices.length && quoteIds.length > 0,
			"ADLFacet: Invalid array lengths"
		);

		require(maLayout.adlEnabled[msg.sender], "ADLFacet: ADL not enabled for partyB");

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address partyA = firstQuote.partyA;
		address partyB = firstQuote.partyB;

		require(partyB == msg.sender, "ADLFacet: Sender must be partyB");

		// Check liquidation status
		require(!maLayout.liquidationStatus[partyA], "ADLFacet: PartyA is liquidated");
		require(!maLayout.partyBLiquidationStatus[partyB][partyA], "ADLFacet: PartyB is liquidated");
		require(!accountLayout.crossLiquidationDetails[partyB].inProgress, "ADLFacet: PartyB is in cross liquidation");

		// Verify upnl signature
		LibMuonPartyBBatchActions.verifyPairUpnlAndPrices(upnlSig, partyB, partyA, quoteIds);

		// Validate each quote
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			require(quote.partyB == partyB, "ADLFacet: All positions must have same partyB");
			require(quote.partyA == partyA, "ADLFacet: All positions must have same partyA");
			require(quote.quoteStatus == QuoteStatus.OPENED, "ADLFacet: Invalid position state");
			require(LibQuote.quoteOpenAmount(quote) >= filledAmounts[i] && filledAmounts[i] > 0, "ADLFacet: Invalid filled amount");
			require(SymbolStorage.layout().symbols[quote.symbolId].isValid, "ADLFacet: Symbol is not valid");
		}

		// Solvency check
		LibSolvency.isSolventAfterClosePosition(
			quoteIds,
			filledAmounts,
			closedPrices,
			upnlSig.prices, // Market prices for solvency
			upnlSig.upnlPartyB,
			upnlSig.upnlPartyA,
			partyB,
			partyA
		);

		// Update nonces
		accountLayout.partyBNonces[partyB][partyA] += 1;
		accountLayout.partyANonces[partyA] += 1;

		// Execute closes
		QuoteStatus[] memory statuses = new QuoteStatus[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			LibQuote.closeQuote(quote, filledAmounts[i], closedPrices[i]);
			statuses[i] = quote.quoteStatus;
		}

		return statuses;
	}
}
