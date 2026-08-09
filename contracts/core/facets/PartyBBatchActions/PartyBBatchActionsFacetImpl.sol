// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyBBatchActions } from "../../libraries/muon/LibMuonPartyBBatchActions.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibSolverFee } from "../../libraries/LibSolverFee.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { LibPartyBState } from "../../libraries/extensions/LibPartyBState.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { PairUpnlAndPricesSig } from "../../storages/MuonStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";

import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";
import { LibSendQuoteEvents } from "../../libraries/LibSendQuoteEvents.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library PartyBBatchActionsFacetImpl {
	using LockedValuesOps for LockedValues;
	using LibPartyBState for address;

	/// @notice Opens multiple positions in a single transaction with shared solvency verification
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
		bool requireMuonAndSolvencyChecks = (TradingModeStorage.layout().bindState[firstQuote.partyA].partyB != LibSigner.getSigner() ||
			!TradingModeStorage.layout().isPartyBBindable[LibSigner.getSigner()]);

		// Check symbol restrictions for all quotes
		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			require(maLayout.affiliateStatus[quote.affiliate] || quote.affiliate == address(0), "PartyBFacet: Invalid affiliate");
			require(
				quote.affiliate == address(0) || appLayout.affiliateShutdownTime[quote.affiliate] == 0,
				"PartyBFacet: Affiliate shutdown scheduled"
			);
			require(
				LibConnections.isSymbolAllowedForPartyA(quote.partyA, quote.symbolId),
				"PartyBFacet: Symbol not allowed due to connection restrictions"
			);
		}

		// PartyB open positions not paused for this specific PartyB
		require(!appLayout.partyBOpenPositionsPausedPerPartyB[firstQuote.partyB], "PartyBFacet: PartyB open positions paused");

		// PartyA and PartyB are not suspended
		require(!accountLayout.suspendedAddresses[firstQuote.partyA], "PartyBFacet: PartyA is Suspended");
		require(!accountLayout.suspendedAddresses[firstQuote.partyB], "PartyBFacet: Sender is Suspended");

		// PartyB is not in emergency mode
		require(!appLayout.partyBEmergencyStatus[firstQuote.partyB], "PartyBFacet: PartyB is in emergency mode");
		require(!appLayout.emergencyMode, "PartyBFacet: System is in emergency mode");

		// Solvency checks
		require(!maLayout.liquidationStatus[firstQuote.partyA], "PartyBFacet: PartyA isn't solvent");
		firstQuote.partyB.requireNotLiquidating(firstQuote.partyA);

		if (requireMuonAndSolvencyChecks) {
			// Verify the upnl and prices
			LibMuonPartyBBatchActions.verifyPairUpnlAndPrices(upnlSig, firstQuote.partyB, firstQuote.partyA, quoteIds, MuonFunction.Trading);
		}

		LibAccount.increaseBothUpnlCounters(firstQuote.partyB, firstQuote.partyA);

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
			LibPartiesEvents.emitOpenPosition(quote, quoteIds[i], filledAmounts[i], openedPrices[i]);
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
							solverFeeCaps: LibSolverFee.caps(QuoteStorage.layout().solverFeeStates[newId]),
							data: newQuote.data
						})
					);
				} else if (newQuote.quoteStatus == QuoteStatus.CANCELED) {
					emit LibPartiesEvents.AcceptCancelRequest(newQuote.id, QuoteStatus.CANCELED);
				}
			}
		}
		if (requireMuonAndSolvencyChecks) {
			LibSolvency.requireSolventAfterOpenPosition(
				quoteIds,
				filledAmounts,
				upnlSig.prices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				firstQuote.partyB,
				firstQuote.partyA
			);
		}
	}

	/// @notice Closes multiple positions in a single transaction, supporting both normal close and ADL flows
	function closePositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) internal returns (QuoteStatus[] memory quoteStatuses, uint256[] memory closeIds) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		require(
			quoteIds.length == filledAmounts.length && quoteIds.length == closedPrices.length && quoteIds.length > 0,
			"PartyBFacet: Invalid length"
		);

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address firstQuotePartyA = firstQuote.partyA;
		address firstQuotePartyB = firstQuote.partyB;
		bool requireMuonAndSolvencyChecks = (TradingModeStorage.layout().bindState[firstQuote.partyA].partyB != LibSigner.getSigner() ||
			!TradingModeStorage.layout().isPartyBBindable[LibSigner.getSigner()]);

		if (requireMuonAndSolvencyChecks) {
			// Verify the upnl and prices
			LibMuonPartyBBatchActions.verifyPairUpnlAndPrices(upnlSig, firstQuotePartyB, firstQuotePartyA, quoteIds, MuonFunction.Trading);
			LibSolvency.requireSolventAfterClosePosition(
				quoteIds,
				filledAmounts,
				closedPrices,
				upnlSig.prices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				firstQuotePartyB,
				firstQuotePartyA
			);
		}

		// Solvency checks
		require(!maLayout.liquidationStatus[firstQuotePartyA], "PartyBFacet: PartyA isn't solvent");
		firstQuotePartyB.requireNotLiquidating(firstQuotePartyA);

		LibAccount.increaseBothUpnlCounters(firstQuotePartyB, firstQuotePartyA);

		quoteStatuses = new QuoteStatus[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);

		for (uint256 i = 0; i < quoteIds.length; i++) {
			uint256 quoteId = quoteIds[i];
			Quote storage quote = quoteLayout.quotes[quoteId];

			require(quote.partyB == firstQuotePartyB, "PartyBBatchActionsFacet: All positions must have same partyB");
			require(quote.partyA == firstQuotePartyA, "PartyBBatchActionsFacet: All positions must have same partyA");
			require(quote.partyB == LibSigner.getSigner(), "PartyBFacet: Sender should be the partyB");
			LibPartyBPositionsActions.fillCloseRequest(quoteId, filledAmounts[i], closedPrices[i]);
			quoteStatuses[i] = quote.quoteStatus;
			closeIds[i] = quoteLayout.closeIds[quoteId];
		}
	}
}
