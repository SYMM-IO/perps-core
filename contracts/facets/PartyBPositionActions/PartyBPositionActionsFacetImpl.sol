// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyB } from "../../libraries/muon/LibMuonPartyB.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";

library PartyBPositionActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) internal returns (uint256 currentId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(accountLayout.suspendedAddresses[quote.partyA] == false, "PartyBFacet: PartyA is suspended");
		require(!accountLayout.suspendedAddresses[LibSigner.getSigner()], "PartyBFacet: Sender is Suspended");
		require(!appLayout.partyBEmergencyStatus[quote.partyB], "PartyBFacet: PartyB is in emergency mode");
		require(!appLayout.emergencyMode, "PartyBFacet: System is in emergency mode");

		// Check symbol restriction based on connections
		require(
			LibConnections.isSymbolAllowedForPartyA(quote.partyA, quote.symbolId),
			"PartyBFacet: Symbol not allowed due to connection restrictions"
		);

		accountLayout.partyANonces[quote.partyA] += 1;
		LibAccount.increasePartyBNonce(quote.partyB, quote.partyA);

		currentId = LibPartyBPositionsActions.openPosition(quoteId, filledAmount, openedPrice);

		if (quote.quoteStatus == QuoteStatus.OPENED) {
			LibConnections.addConnection(quote.partyA, quote.partyB);
		}

		if (accountLayout.bindState[quote.partyA].partyB != quote.partyB || !accountLayout.isPartyBBindable[quote.partyB]) {
			LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId);

			uint256[] memory quoteIds = new uint256[](1);
			uint256[] memory filledAmounts = new uint256[](1);
			uint256[] memory marketPrices = new uint256[](1);
			quoteIds[0] = quoteId;
			filledAmounts[0] = filledAmount;
			marketPrices[0] = upnlSig.price;
			LibSolvency.isSolventAfterOpenPosition(
				quoteIds,
				filledAmounts,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
		}
	}

	function fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, PairUpnlAndPriceSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		if (accountLayout.bindState[quote.partyA].partyB != LibSigner.getSigner() || !accountLayout.isPartyBBindable[LibSigner.getSigner()]) {
			LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId);
			uint256[] memory quoteIds = new uint256[](1);
			uint256[] memory filledAmounts = new uint256[](1);
			uint256[] memory closedPrices = new uint256[](1);
			uint256[] memory marketPrices = new uint256[](1);
			quoteIds[0] = quoteId;
			filledAmounts[0] = filledAmount;
			closedPrices[0] = closedPrice;
			marketPrices[0] = upnlSig.price;
			LibSolvency.isSolventAfterClosePosition(
				quoteIds,
				filledAmounts,
				closedPrices,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
		}
		LibAccount.increasePartyBNonce(quote.partyB, quote.partyA);
		accountLayout.partyANonces[quote.partyA] += 1;
		LibPartyBPositionsActions.fillCloseRequest(quoteId, filledAmount, closedPrice);
	}

	function acceptCancelCloseRequest(uint256 quoteId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING, "PartyBFacet: Invalid state");
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.OPENED;
		quote.requestedClosePrice = 0;
		quote.quantityToClose = 0;
	}
}
