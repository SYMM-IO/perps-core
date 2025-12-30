// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyBBatchActions } from "../../libraries/muon/LibMuonPartyBBatchActions.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { LibPartyBPositionsActions } from "../../libraries/LibPartyBPositionsActions.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage, Quote, PositionType, OrderType, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { PairUpnlAndPricesSig } from "../../storages/MuonStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibPartyBBatchEvents } from "../../libraries/PartysEvents.sol";

library PartyBBatchActionsFacetImpl {
	using LockedValuesOps for LockedValues;
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
		require(!accountLayout.crossLiquidationDetails[firstQuote.partyB].inProgress, "PartyBFacet: PartyB is in cross liquidation process");

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
			emit LibPartyBBatchEvents.OpenPosition(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], openedPrices[i]);
			emit LibPartyBBatchEvents.OpenPosition(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], openedPrices[i], quote.lockedValues);
			if (newId != 0) {
				Quote storage newQuote = QuoteStorage.layout().quotes[newId];
				if (newQuote.quoteStatus == QuoteStatus.PENDING) {
					emit LibPartyBBatchEvents.SendQuote(
						newQuote.partyA,
						newQuote.id,
						newQuote.partyBsWhiteList,
						newQuote.symbolId,
						newQuote.positionType,
						newQuote.orderType,
						newQuote.requestedOpenPrice,
						newQuote.marketPrice,
						newQuote.quantity,
						newQuote.lockedValues.cva,
						newQuote.lockedValues.lf,
						newQuote.lockedValues.partyAmm,
						newQuote.lockedValues.partyBmm,
						newQuote.tradingFee,
						newQuote.deadline
					);
				} else if (newQuote.quoteStatus == QuoteStatus.CANCELED) {
					emit LibPartyBBatchEvents.AcceptCancelRequest(newQuote.id, QuoteStatus.CANCELED);
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

		if (accountLayout.bindState[firstQuote.partyA].partyB != LibSigner.getSigner() || !accountLayout.isPartyBBindable[LibSigner.getSigner()]) {
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
		require(!accountLayout.crossLiquidationDetails[firstQuotePartyB].inProgress, "PartyBFacet: PartyB is in cross liquidation process");

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

	function adlClose(
		uint256[] calldata quoteIds,
		uint256 ratio,
		uint256 price
	) internal returns (uint256[] memory filledAmounts, uint256 closedAmount, uint256[] memory closeIds) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256 firstSymbolId;
		uint256 len = quoteIds.length;
		filledAmounts = new uint256[](len);
		closeIds = new uint256[](len);

		require(ratio > 0 && ratio <= 1e18, "PartyBBatchActionsFacet: Invalid ratio");
		require(quoteIds.length > 0, "PartyBBatchActionsFacet: invalid array length");
		require(
			!accountLayout.crossLiquidationDetails[quoteLayout.quotes[quoteIds[0]].partyB].inProgress,
			"PartyBFacet: PartyB is in cross liquidation process"
		);

		for (uint256 i = 0; i < len; ) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];

			require(quote.partyB == LibSigner.getSigner(), "PartyBFacet: Sender isn't partyB of quote");
			require(!MAStorage.layout().liquidationStatus[quote.partyA], "PartyBFacet: PartyA is liquidated");
			require(!MAStorage.layout().partyBLiquidationStatus[quote.partyB][quote.partyA], "PartyBFacet: PartyB is liquidated");
			if (i == 0) {
				firstSymbolId = quote.symbolId;
			} else {
				require(quote.symbolId == firstSymbolId, "PartyBFacet: Symbols not match");
			}

			bool wasClosePending = quote.quoteStatus == QuoteStatus.CLOSE_PENDING;
			uint256 userRequestedClosePrice = wasClosePending ? quote.requestedClosePrice : 0;
			uint256 userRequestedQuantityToClose = wasClosePending ? quote.quantityToClose : 0;
			uint256 previousCloseId = quoteLayout.closeIds[quote.id];

			if (quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING) {
				emit LibPartyBBatchEvents.AcceptCancelCloseRequest(quote.id, QuoteStatus.OPENED, previousCloseId);
				quote.statusModifyTimestamp = block.timestamp;
				quote.quoteStatus = QuoteStatus.OPENED;
				quote.requestedClosePrice = 0;
				quote.quantityToClose = 0;
			}

			if (quote.quoteStatus == QuoteStatus.OPENED || quote.quoteStatus == QuoteStatus.CLOSE_PENDING) {
				uint256 openAmount = LibQuote.quoteOpenAmount(quote);
				uint256 adlAmount = (openAmount * ratio) / 1e18;

				require(adlAmount > 0 && openAmount >= adlAmount, "PartyBFacet: Invalid filled amount");

				int256 fundingFee = LibQuoteFunding.getAccumulatedFundingFee(quote.id);
				uint256 maintenance = ((quote.lockedValues.cva + quote.lockedValues.lf) * adlAmount) / openAmount;
				uint256 requiredA = maintenance;
				uint256 requiredB = maintenance;
				address allocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
				if (fundingFee > 0) {
					requiredA += uint256(fundingFee);
				} else if (fundingFee < 0) {
					requiredB += uint256(-fundingFee);
				}

				bool partyAOk = accountLayout.allocatedBalances[quote.partyA] >= requiredA;
				if (!partyAOk) {
					emit LibPartyBBatchEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, 1, int256(requiredA));
					unchecked {
						++i;
					}
					continue;
				}

				bool partyBOk = accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] >= requiredB;
				if (!partyBOk) {
					emit LibPartyBBatchEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, 2, int256(requiredB));
					unchecked {
						++i;
					}
					continue;
				}

				if (wasClosePending) {
					emit LibPartyBBatchEvents.RequestToCancelCloseRequest(
						quote.partyA,
						quote.partyB,
						quote.id,
						QuoteStatus.CANCEL_CLOSE_PENDING,
						previousCloseId
					);
					quote.statusModifyTimestamp = block.timestamp;
					quote.quoteStatus = QuoteStatus.OPENED;
					emit LibPartyBBatchEvents.AcceptCancelCloseRequest(quote.id, QuoteStatus.OPENED, previousCloseId);
				}

				uint256 adlCloseId = ++quoteLayout.lastCloseId;
				closeIds[i] = adlCloseId;
				quoteLayout.closeIds[quote.id] = adlCloseId;
				quote.quantityToClose = adlAmount;
				quote.requestedClosePrice = price;
				emit LibPartyBBatchEvents.RequestToClosePosition(
					quote.partyA,
					quote.partyB,
					quote.id,
					price,
					adlAmount,
					quote.orderType,
					block.timestamp,
					QuoteStatus.CLOSE_PENDING,
					adlCloseId
				);
				emit LibPartyBBatchEvents.RequestToClosePosition(
					quote.partyA,
					quote.partyB,
					quote.id,
					price,
					adlAmount,
					quote.orderType,
					block.timestamp,
					QuoteStatus.CLOSE_PENDING
				);

				LibAccount.increasePartyBNonce(quote.partyB, quote.partyA);
				accountLayout.partyANonces[quote.partyA] += 1;
				LibQuoteClose.closeQuote(quote.id, adlAmount, price);
				closedAmount += adlAmount;
				filledAmounts[i] = adlAmount;

				if (wasClosePending) {
					uint256 remainingOpen = LibQuote.quoteOpenAmount(quote);
					if (remainingOpen > 0 && userRequestedQuantityToClose > 0) {
						uint256 newQuantity = remainingOpen >= userRequestedQuantityToClose ? userRequestedQuantityToClose : remainingOpen;
						quote.quantityToClose = newQuantity;
						quote.requestedClosePrice = userRequestedClosePrice;
						quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
						quote.statusModifyTimestamp = block.timestamp;

						uint256 newCloseId = ++quoteLayout.lastCloseId;
						quoteLayout.closeIds[quote.id] = newCloseId;
						emit LibPartyBBatchEvents.RequestToClosePosition(
							quote.partyA,
							quote.partyB,
							quote.id,
							userRequestedClosePrice,
							newQuantity,
							quote.orderType,
							block.timestamp,
							QuoteStatus.CLOSE_PENDING,
							newCloseId
						);
						emit LibPartyBBatchEvents.RequestToClosePosition(
							quote.partyA,
							quote.partyB,
							quote.id,
							userRequestedClosePrice,
							newQuantity,
							quote.orderType,
							block.timestamp,
							QuoteStatus.CLOSE_PENDING
						);
					}
				}
			}
			unchecked {
				++i;
			}
		}
	}
}
