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
import { LibQuote } from "../../libraries/LibQuote.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues, PositionType, OrderType } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
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

		LibAccount.increaseBothNonces(quote.partyB, quote.partyA);

		currentId = LibPartyBPositionsActions.openPosition(quoteId, filledAmount, openedPrice);

		if (quote.quoteStatus == QuoteStatus.OPENED) {
			LibConnections.addConnection(quote.partyA, quote.partyB);
		}

		if (
			TradingModeStorage.layout().bindState[quote.partyA].partyB != quote.partyB || !TradingModeStorage.layout().isPartyBBindable[quote.partyB]
		) {
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
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		if (
			TradingModeStorage.layout().bindState[quote.partyA].partyB != LibSigner.getSigner() ||
			!TradingModeStorage.layout().isPartyBBindable[LibSigner.getSigner()]
		) {
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
		LibAccount.increaseBothNonces(quote.partyB, quote.partyA);
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

	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) internal returns (uint256 filledAmount) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();

		require(
			quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"PartyBFacet: Invalid state"
		);
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");

		// Validate closed price based on position type
		if (quote.positionType == PositionType.LONG) {
			require(closedPrice >= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		} else {
			require(closedPrice <= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		}

		// Only applicable for LIMIT orders - MARKET orders must be filled completely
		require(quote.orderType == OrderType.LIMIT, "PartyBFacet: Only LIMIT orders supported");

		// Verify signature
		if (
			TradingModeStorage.layout().bindState[quote.partyA].partyB != LibSigner.getSigner() ||
			!TradingModeStorage.layout().isPartyBBindable[LibSigner.getSigner()]
		) {
			LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId);
		}

		// Calculate max close amount that keeps PartyA at liquidation threshold
		(uint256 maxCloseAmount, bool canCloseAll) = LibSolvency.calculateMaxCloseAmountToLiquidation(
			quoteId,
			closedPrice,
			upnlSig.price,
			upnlSig.upnlPartyA
		);

		if (canCloseAll) {
			// Full close is safe - delegate to normal fillCloseRequest
			filledAmount = quote.quantityToClose;
		} else {
			// Need to close partial amount
			filledAmount = maxCloseAmount;

			// Calculate remaining position value after this close
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			uint256 remainingAmount = openAmount - filledAmount;

			// Check minAcceptableQuoteValue constraint for remaining position
			// Only check if there will be a remaining position (not a full close)
			if (remainingAmount > 0) {
				// Match LibQuoteClose rounding for remaining locked values
				uint256 remainingCva = quote.lockedValues.cva - ((quote.lockedValues.cva * filledAmount) / openAmount);
				uint256 remainingLf = quote.lockedValues.lf - ((quote.lockedValues.lf * filledAmount) / openAmount);
				uint256 remainingPartyAmm = quote.lockedValues.partyAmm - ((quote.lockedValues.partyAmm * filledAmount) / openAmount);
				uint256 remainingLockedValue = remainingCva + remainingLf + remainingPartyAmm;
				require(
					remainingLockedValue == 0 || remainingLockedValue >= symbolLayout.symbols[quote.symbolId].minAcceptableQuoteValue,
					"PartyBFacet: Remaining quote value is low"
				);
			}
		}

		require(filledAmount > 0, "PartyBFacet: Cannot close any amount");
		require(filledAmount <= quote.quantityToClose, "PartyBFacet: Invalid filledAmount");

		// Verify PartyB solvency after close
		if (
			TradingModeStorage.layout().bindState[quote.partyA].partyB != LibSigner.getSigner() ||
			!TradingModeStorage.layout().isPartyBBindable[LibSigner.getSigner()]
		) {
			uint256[] memory quoteIds = new uint256[](1);
			uint256[] memory filledAmounts = new uint256[](1);
			uint256[] memory closedPrices = new uint256[](1);
			uint256[] memory marketPrices = new uint256[](1);
			quoteIds[0] = quoteId;
			filledAmounts[0] = filledAmount;
			closedPrices[0] = closedPrice;
			marketPrices[0] = upnlSig.price;

			// Only check PartyB solvency - PartyA is intentionally at liquidation threshold
			(int256 partyBAvailableBalance, ) = LibSolvency.getAvailableBalanceAfterClosePosition(
				quoteIds,
				filledAmounts,
				closedPrices,
				marketPrices,
				upnlSig.upnlPartyB,
				upnlSig.upnlPartyA,
				quote.partyB,
				quote.partyA
			);
			require(partyBAvailableBalance >= 0, "PartyBFacet: PartyB will be insolvent");
		}

		LibAccount.increaseBothNonces(quote.partyB, quote.partyA);
		LibPartyBPositionsActions.fillCloseRequest(quoteId, filledAmount, closedPrice);

		return filledAmount;
	}
}
