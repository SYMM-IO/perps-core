// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyBBatchActions } from "../../libraries/muon/LibMuonPartyBBatchActions.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { QuoteStorage, Quote, PositionType, OrderType, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { PairUpnlAndPricesSig } from "../../storages/MuonStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";

import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";
import { LibSendQuoteEvents } from "../../libraries/LibSendQuoteEvents.sol";

library PartyBBatchActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	// NOTE: Solidity v0.8.18 doesn't support emitting events via qualified identifiers
	// like `emit IPartiesEvents.OpenPosition(...)`. To keep event signatures consistent
	// with `IPartiesEvents`, we redeclare the required events here and emit them unqualified.
	event AcceptCancelRequest(uint256 quoteId, QuoteStatus quoteStatus);
	event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice); // for backward compatibility
	event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice, LockedValues lockedValues);

	function openPositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory openedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		require(
			quoteIds.length == filledAmounts.length && quoteIds.length == openedPrices.length && quoteIds.length > 0,
			"PartyBFacet: Invalid length"
		);

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];

		// Check symbol restrictions for all quotes
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			require(
				LibConnections.isSymbolAllowedForPartyA(quote.partyA, quote.symbolId),
				"PartyBFacet: Symbol not allowed due to connection restrictions"
			);
		}

		// PartyA and PartyB are not suspended
		require(!accountLayout.suspendedAddresses[firstQuote.partyA], "PartyBFacet: PartyA is Suspended");
		require(!accountLayout.suspendedAddresses[firstQuote.partyB], "PartyBFacet: Sender is Suspended");

		// PartyB is not in emergency mode
		require(!appLayout.partyBEmergencyStatus[firstQuote.partyB], "PartyBFacet: PartyB is in emergency mode");
		require(!appLayout.emergencyMode, "PartyBFacet: System is in emergency mode");

		// Solvency checks
		require(!maLayout.liquidationStatus[firstQuote.partyA], "PartyBFacet: PartyA isn't solvent");
		require(!maLayout.partyBLiquidationStatus[firstQuote.partyB][firstQuote.partyA], "PartyBFacet: PartyB isn't solvent");
		require(!ClearingHouseStorage.layout().crossLiquidationDetails[firstQuote.partyB].inProgress, "PartyBFacet: PartyB is in cross liquidation process");

		// Verify the upnl and prices
		LibMuonPartyBBatchActions.verifyPairUpnlAndPrices(upnlSig, firstQuote.partyB, firstQuote.partyA, quoteIds);

		accountLayout.partyANonces[firstQuote.partyA] += 1;
		LibAccount.increasePartyBNonce(firstQuote.partyB, firstQuote.partyA);

		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];
			Quote storage quote = quoteLayout.quotes[quoteId];
			require(quote.partyB == LibSigner.getSigner(), "PartyBFacet: Sender should be the partyB");
			require(firstQuote.partyA == quote.partyA, "PartyBFacet: All positions should belong to one partyA");
			uint256 newId = LibPartyBPositionsActions.openPosition(quoteId, filledAmounts[i], openedPrices[i]);
			if (quote.quoteStatus == QuoteStatus.OPENED) {
				LibConnections.addConnection(quote.partyA, quote.partyB);
			}
			// Emitting events here in the impl is against our standards in these contracts,
			// but given that this contract is getting too large and we can't return the ids, we are allowing it here.
			emit LibPartiesEvents.OpenPosition(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], openedPrices[i]);
			emit LibPartiesEvents.OpenPosition(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], openedPrices[i], quote.lockedValues);
			if (newId != 0) {
				Quote storage newQuote = QuoteStorage.layout().quotes[newId];
				if (newQuote.quoteStatus == QuoteStatus.PENDING) {
					LibSendQuoteEvents.emitSendQuoteEvents(
						LibSendQuoteEvents.SendQuoteEventParams({
							partyA: newQuote.partyA,
							quoteId: newQuote.id,
							partyBsWhiteList: newQuote.partyBsWhiteList,
							symbolId: newQuote.symbolId,
							positionType: newQuote.positionType,
							orderType: newQuote.orderType,
							price: newQuote.requestedOpenPrice,
							marketPrice: newQuote.marketPrice,
							quantity: newQuote.quantity,
							cva: newQuote.lockedValues.cva,
							lf: newQuote.lockedValues.lf,
							partyAmm: newQuote.lockedValues.partyAmm,
							partyBmm: newQuote.lockedValues.partyBmm,
							tradingFee: newQuote.tradingFee,
							deadline: newQuote.deadline,
							affiliate: newQuote.affiliate,
							data: newQuote.data
						})
					);
				} else if (newQuote.quoteStatus == QuoteStatus.CANCELED) {
					emit LibPartiesEvents.AcceptCancelRequest(newQuote.id, QuoteStatus.CANCELED);
				}
			}
		}
		LibSolvency.isSolventAfterOpenPosition(
			quoteIds,
			filledAmounts,
			upnlSig.prices,
			upnlSig.upnlPartyB,
			upnlSig.upnlPartyA,
			firstQuote.partyB,
			firstQuote.partyA
		);
	}

	function closePositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig,
		bool isAdl
	) internal returns (QuoteStatus[] memory quoteStatuses, uint256[] memory closeIds) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();

		require(
			quoteIds.length == filledAmounts.length && quoteIds.length == closedPrices.length && quoteIds.length > 0,
			"PartyBFacet: Invalid length"
		);

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address firstQuotePartyA = firstQuote.partyA;
		address firstQuotePartyB = firstQuote.partyB;

		if (TradingModeStorage.layout().bindState[firstQuote.partyA].partyB != LibSigner.getSigner() || !TradingModeStorage.layout().isPartyBBindable[LibSigner.getSigner()]) {
			// Verify the upnl and prices
			LibMuonPartyBBatchActions.verifyPairUpnlAndPrices(upnlSig, firstQuotePartyB, firstQuotePartyA, quoteIds);
		}

		LibSolvency.isSolventAfterClosePosition(
			quoteIds,
			filledAmounts,
			closedPrices,
			upnlSig.prices,
			upnlSig.upnlPartyB,
			upnlSig.upnlPartyA,
			firstQuotePartyB,
			firstQuotePartyA
		);

		// Solvency checks
		require(!maLayout.liquidationStatus[firstQuotePartyA], "PartyBFacet: PartyA isn't solvent");
		require(!maLayout.partyBLiquidationStatus[firstQuotePartyB][firstQuotePartyA], "PartyBFacet: PartyB isn't solvent");
		require(!ClearingHouseStorage.layout().crossLiquidationDetails[firstQuotePartyB].inProgress, "PartyBFacet: PartyB is in cross liquidation process");

		LibAccount.increasePartyBNonce(firstQuotePartyB, firstQuotePartyA);
		accountLayout.partyANonces[firstQuotePartyA] += 1;

		quoteStatuses = new QuoteStatus[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);

		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];
			Quote storage quote = quoteLayout.quotes[quoteId];

			require(quote.partyB == firstQuotePartyB, "PartyBBatchActionsFacet: All positions must have same partyB");
			require(quote.partyA == firstQuotePartyA, "PartyBBatchActionsFacet: All positions must have same partyA");

			if (isAdl) {
				uint256 quantityToClose = filledAmounts[i];
				uint256 openAmount = LibQuote.quoteOpenAmount(quote);
				require(quote.quoteStatus == QuoteStatus.OPENED, "PartyBBatchActionsFacet: Invalid position state");
				require(openAmount >= quantityToClose && quantityToClose > 0, "PartyBBatchActionsFacet: Invalid filled amount");
				if (openAmount > quantityToClose) {
					require(
						((openAmount - quantityToClose) * quote.lockedValues.totalForPartyA()) / openAmount >=
							symbolLayout.symbols[quote.symbolId].minAcceptableQuoteValue,
						"PartyBBatchActionsFacet: Remaining quote value is low"
					);
				}
				quote.quantityToClose = quantityToClose;
				LibQuoteClose.closeQuote(quote.id, filledAmounts[i], closedPrices[i]);
				quoteStatuses[i] = quote.quoteStatus;
				closeIds[i] = 0; // not used in ADL
			} else {
				// Normal close request flow
				require(quote.partyB == LibSigner.getSigner(), "PartyBFacet: Sender should be the partyB");
				LibPartyBPositionsActions.fillCloseRequest(quoteId, filledAmounts[i], closedPrices[i]);
				quoteStatuses[i] = quote.quoteStatus;
				closeIds[i] = quoteLayout.closeIds[quoteId];
			}
		}
	}

}
