// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../libraries/muon/LibMuonPartyB.sol";
import "../../libraries/LibPartiesEvents.sol";
import "../../libraries/LibSolvency.sol";
import "../../libraries/LibPartyBPositionsActions.sol";
import "../../storages/MAStorage.sol";

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
		require(!accountLayout.suspendedAddresses[msg.sender], "PartyBFacet: Sender is Suspended");
		require(!appLayout.partyBEmergencyStatus[quote.partyB], "PartyBFacet: PartyB is in emergency mode");
		require(!appLayout.emergencyMode, "PartyBFacet: System is in emergency mode");
		// NOTICE: This part is commented because in this version each user will be isolated with only one partyB
		// LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId);
		accountLayout.partyANonces[quote.partyA] += 1;
		accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;

		currentId = LibPartyBPositionsActions.openPosition(quoteId, filledAmount, openedPrice);

		// NOTICE: This part is commented because in this version each user will be isolated with only one partyB
		// uint256[] memory quoteIds = new uint256[](1);
		// uint256[] memory filledAmounts = new uint256[](1);
		// uint256[] memory marketPrices = new uint256[](1);
		// quoteIds[0] = quoteId;
		// filledAmounts[0] = filledAmount;
		// marketPrices[0] = upnlSig.price;
		// LibSolvency.isSolventAfterOpenPosition(
		// 	quoteIds,
		// 	filledAmounts,
		// 	marketPrices,
		// 	upnlSig.upnlPartyB,
		// 	upnlSig.upnlPartyA,
		// 	quote.partyB,
		// 	quote.partyA
		// );
	}

	function fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, PairUpnlAndPriceSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		// NOTICE: This part is commented because in this version each user will be isolated with only one partyB
		// LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId);
		// uint256[] memory quoteIds = new uint256[](1);
		// uint256[] memory filledAmounts = new uint256[](1);
		// uint256[] memory closedPrices = new uint256[](1);
		// uint256[] memory marketPrices = new uint256[](1);
		// quoteIds[0] = quoteId;
		// filledAmounts[0] = filledAmount;
		// closedPrices[0] = closedPrice;
		// marketPrices[0] = upnlSig.price;
		// LibSolvency.isSolventAfterClosePosition(
		// 	quoteIds,
		// 	filledAmounts,
		// 	closedPrices,
		// 	marketPrices,
		// 	upnlSig.upnlPartyB,
		// 	upnlSig.upnlPartyA,
		// 	quote.partyB,
		// 	quote.partyA
		// );
		accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;
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

	function emergencyClosePosition(uint256 quoteId, PairUpnlAndPriceSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		Symbol memory symbol = SymbolStorage.layout().symbols[quote.symbolId];
		require(
			GlobalAppStorage.layout().emergencyMode || GlobalAppStorage.layout().partyBEmergencyStatus[quote.partyB] || !symbol.isValid,
			"PartyBFacet: Operation not allowed. Either emergency mode must be active, party B must be in emergency status, or the symbol must be delisted"
		);
		require(quote.quoteStatus == QuoteStatus.OPENED || quote.quoteStatus == QuoteStatus.CLOSE_PENDING, "PartyBFacet: Invalid state");
		// LibMuonPartyB.verifyPairUpnlAndPrice(upnlSig, quote.partyB, quote.partyA, quote.symbolId);
		uint256 filledAmount = LibQuote.quoteOpenAmount(quote);
		quote.quantityToClose = filledAmount;
		quote.requestedClosePrice = upnlSig.price;
		require(
			LibAccount.partyAAvailableBalanceForLiquidation(upnlSig.upnlPartyA, accountLayout.allocatedBalances[quote.partyA], quote.partyA) >= 0,
			"PartyBFacet: PartyA is insolvent"
		);
		// require(
		// 	LibAccount.partyBAvailableBalanceForLiquidation(upnlSig.upnlPartyB, quote.partyB, quote.partyA) >= 0,
		// 	"PartyBFacet: PartyB should be solvent"
		// );
		accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;
		accountLayout.partyANonces[quote.partyA] += 1;
		LibQuote.closeQuote(quote, filledAmount, upnlSig.price);
	}

	
	/**
	 * @notice Auto-deleverages a quote proportionally, checking solvency buffers and preserving pending close intents.
	 * @dev Keeps quote closeId/status consistent with existing CLOSE_PENDING/CANCEL_CLOSE_PENDING flows and emits ADL events.
	 * @param quoteId Quote to ADL close (same partyA/partyB/symbol).
	 * @param amount Amount to close (token decimals).
	 * @param price Execution price used for the ADL close.
	 */
	function adlClose(uint256 quoteId, uint256 amount, uint256 price) internal  {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		address signer = msg.sender;

		require(quote.partyB == signer, "PartyBFacet: Sender isn't partyB of quote");
		require(!maLayout.partyBLiquidationStatus[quote.partyB][quote.partyA], "PartyBFacet: PartyB is liquidated");
		require(!maLayout.liquidationStatus[quote.partyA], "PartyAFacet: PartyA is in liquidation process");

		require(
			quote.quoteStatus == QuoteStatus.OPENED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"PartyBFacet: Invalid state"
		);

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
					emit LibPartiesEvents.RequestToCancelCloseRequest(quote.partyA, quote.partyB, quote.id, QuoteStatus.CANCEL_CLOSE_PENDING);
				}
				emit LibPartiesEvents.AcceptCancelCloseRequest(quote.id, QuoteStatus.OPENED, previousCloseId);
				emit LibPartiesEvents.AcceptCancelCloseRequest(quote.id, QuoteStatus.OPENED);
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
		emit LibPartiesEvents.RequestToClosePosition(
			quote.partyA,
			quote.partyB,
			quote.id,
			price,
			amount,
			OrderType.MARKET,
			block.timestamp,
			QuoteStatus.CLOSE_PENDING
		);

			//Update nonce
		accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;
		accountLayout.partyANonces[quote.partyA] += 1;

		LibQuote.closeQuote(quote, amount, price);
		emit LibPartiesEvents.FillCloseRequest(quote.id, quote.partyA, quote.partyB, amount, price, quote.quoteStatus, adlCloseId);
		emit LibPartiesEvents.FillCloseRequest(quote.id, quote.partyA, quote.partyB, amount, price, quote.quoteStatus);
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
				emit LibPartiesEvents.RequestToClosePosition(
					quote.partyA,
					quote.partyB,
					quote.id,
					prevRequestedClosePrice,
					newQuantity,
					quote.orderType,
					block.timestamp,
					QuoteStatus.CLOSE_PENDING
				);
				if (wasCancelClosePending) {
					emit LibPartiesEvents.RequestToCancelCloseRequest(quote.partyA, quote.partyB, quote.id, QuoteStatus.CANCEL_CLOSE_PENDING, newCloseId);
					emit LibPartiesEvents.RequestToCancelCloseRequest(quote.partyA, quote.partyB, quote.id, QuoteStatus.CANCEL_CLOSE_PENDING);
				}
			}
		}
}
