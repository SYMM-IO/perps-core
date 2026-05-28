// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyB } from "../../libraries/muon/LibMuonPartyB.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteState } from "../../libraries/extensions/LibQuoteState.sol";
import { LibPartyBState } from "../../libraries/extensions/LibPartyBState.sol";
import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";
import { Symbol, SymbolStorage } from "../../storages/SymbolStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, OrderType } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library PartyBEmergencyActionsFacetImpl {
	using LibPartyBState for address;
	using LibQuoteState for Quote;

	/// @notice Closes a position fully during emergency mode, symbol delisting, or partyB emergency status
	function emergencyClosePosition(uint256 quoteId, PairUpnlAndPriceSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		Symbol memory symbol = SymbolStorage.layout().symbols[quote.symbolId];
		bool affiliateShutdownScheduled = quote.affiliate != address(0) && GlobalAppStorage.layout().affiliateShutdownTime[quote.affiliate] != 0;
		require(
			GlobalAppStorage.layout().emergencyMode ||
				GlobalAppStorage.layout().partyBEmergencyStatus[quote.partyB] ||
				affiliateShutdownScheduled ||
				!symbol.isValid,
			"PartyBFacet: Operation not allowed. Either emergency mode must be active, party B must be in emergency status, or the symbol must be delisted"
		);
		require(quote.quoteStatus == QuoteStatus.OPENED || quote.quoteStatus == QuoteStatus.CLOSE_PENDING, "PartyBFacet: Invalid state");
		LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId, MuonFunction.Trading);
		uint256 filledAmount = LibQuote.quoteOpenAmount(quote);
		quote.quantityToClose = filledAmount;
		quote.requestedClosePrice = upnlSig.price;
		require(
			LibAccount.partyAAvailableBalanceForLiquidation(upnlSig.upnlPartyA, accountLayout.allocatedBalances[quote.partyA], quote.partyA) >= 0,
			"PartyBFacet: PartyA is insolvent"
		);
		require(
			LibAccount.partyBAvailableBalanceForLiquidation(upnlSig.upnlPartyB, quote.partyB, quote.partyA) >= 0,
			"PartyBFacet: PartyB should be solvent"
		);

		LibAccount.increaseBothNonces(quote.partyB, quote.partyA);
		LibQuoteClose.closeQuote(quote.id, filledAmount, upnlSig.price);
	}

	/// @notice Auto-deleverages a quote by a specified amount, checking solvency buffers and preserving pending close intents
	/// @dev Keeps quote closeId/status consistent with existing CLOSE_PENDING/CANCEL_CLOSE_PENDING flows and emits ADL events
	/// @param quoteId Quote to ADL close (same partyA/partyB/symbol).
	/// @param amount Quantity to close.
	/// @param price Execution price used for the ADL close.
	function adlClose(uint256 quoteId, uint256 amount, uint256 price) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		address signer = LibSigner.getSigner();

		require(quote.partyB == signer, "PartyBFacet: Sender isn't partyB of quote");
		require(MAStorage.layout().adlEnabled[signer], "PartyBFacet: ADL disabled");
		signer.requireNotCrossLiquidating();
		quote.partyB.requireNotLiquidatingAgainst(quote.partyA);
		require(!maLayout.liquidationStatus[quote.partyA], "PartyAFacet: PartyA is in liquidation process");

		quote.requireOpenPosition();

		// Get quote related data
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		require(amount != 0 && amount <= openAmount, "PartyBFacet: Invalid amount");

		// Preserve any pending close intent by temporarily returning the position to OPENED.
		bool wasClosePending = quote.quoteStatus == QuoteStatus.CLOSE_PENDING;
		bool wasCancelClosePending = quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING;
		uint256 prevRequestedClosePrice;
		uint256 prevRequestedQuantityToClose;
		uint256 previousCloseId;
		if (wasClosePending || wasCancelClosePending) {
			previousCloseId = quoteLayout.closeIds[quote.id];
			prevRequestedClosePrice = quote.requestedClosePrice;
			prevRequestedQuantityToClose = quote.quantityToClose;

			if (wasClosePending) {
				emit LibPartiesEvents.RequestToCancelCloseRequest(
					quote.partyA,
					quote.partyB,
					quote.id,
					QuoteStatus.CANCEL_CLOSE_PENDING,
					previousCloseId
				);
			}
			emit LibPartiesEvents.AcceptCancelCloseRequest(quote.id, QuoteStatus.CANCELED, previousCloseId);
			quote.quantityToClose = 0;
			quote.requestedClosePrice = 0;
			quote.quoteStatus = QuoteStatus.OPENED;
			quote.statusModifyTimestamp = block.timestamp;
		}

		uint256 adlCloseId = ++quoteLayout.lastCloseId;
		quoteLayout.closeIds[quote.id] = adlCloseId;
		quote.quantityToClose = amount;
		quote.requestedClosePrice = price;
		quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
		quote.statusModifyTimestamp = block.timestamp;
		emit LibPartiesEvents.RequestToClosePosition(
			quote.partyA,
			quote.partyB,
			quote.id,
			price,
			amount,
			OrderType.MARKET,
			block.timestamp,
			QuoteStatus.CLOSE_PENDING,
			adlCloseId
		);

		//Update nonce
		LibAccount.increaseBothNonces(quote.partyB, quote.partyA);

		LibQuoteClose.closeQuote(quote.id, amount, price);
		emit LibPartiesEvents.FillCloseRequest(quote.id, quote.partyA, quote.partyB, amount, price, quote.quoteStatus, adlCloseId);
		emit LibPartiesEvents.FillCloseRequest(
			quote.id,
			quote.partyA,
			quote.partyB,
			amount,
			price,
			quote.quoteStatus,
			adlCloseId,
			quote.lockedValues
		);
		uint256 remainingOpen = LibQuote.quoteOpenAmount(quote);

		if ((wasClosePending || wasCancelClosePending) && remainingOpen > 0) {
			uint256 newQuantity = remainingOpen >= prevRequestedQuantityToClose ? prevRequestedQuantityToClose : remainingOpen;
			uint256 newCloseId = ++quoteLayout.lastCloseId;
			quote.quantityToClose = newQuantity;
			quote.requestedClosePrice = prevRequestedClosePrice;
			quote.quoteStatus = wasCancelClosePending ? QuoteStatus.CANCEL_CLOSE_PENDING : QuoteStatus.CLOSE_PENDING;
			quote.statusModifyTimestamp = block.timestamp;
			quoteLayout.closeIds[quote.id] = newCloseId;
			emit LibPartiesEvents.RequestToClosePosition(
				quote.partyA,
				quote.partyB,
				quote.id,
				prevRequestedClosePrice,
				newQuantity,
				quote.orderType,
				block.timestamp,
				QuoteStatus.CLOSE_PENDING,
				newCloseId
			);
			if (wasCancelClosePending) {
				emit LibPartiesEvents.RequestToCancelCloseRequest(quote.partyA, quote.partyB, quote.id, QuoteStatus.CANCEL_CLOSE_PENDING, newCloseId);
			}
		}
	}
}
