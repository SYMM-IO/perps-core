// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage, Quote, OrderType, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";

library ADLFacetImpl {
	/**
	 * @notice Auto-deleverages a quote proportionally, checking solvency buffers and preserving pending close intents.
	 * @dev Keeps quote closeId/status consistent with existing CLOSE_PENDING/CANCEL_CLOSE_PENDING flows and emits ADL events.
	 * @param quoteId Quote to ADL close (same partyA/partyB/symbol).
	 * @param amount Amount to close (token decimals).
	 * @param price Execution price used for the ADL close.
	 */
	function adlClose(uint256 quoteId, uint256 amount, uint256 price) internal returns (uint256 closedAmount) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		address signer = LibSigner.getSigner();

		require(quote.partyB == signer, "PartyBFacet: Sender isn't partyB of quote");
		require(maLayout.adlEnabled[signer], "PartyBFacet: ADL disabled");
		require(!accountLayout.crossLiquidationDetails[signer].inProgress, "PartyBFacet: PartyB is in cross liquidation process");
		require(!maLayout.partyBLiquidationStatus[quote.partyB][quote.partyA], "PartyBFacet: PartyB is liquidated");
		require(!maLayout.liquidationStatus[quote.partyA], "PartyAFacet: PartyA is in liquidation process");

		// how to check it in symmio party B
		// require(quote.symbolId == firstQuote.symbolId, "PartyBFacet: Symbols not match");

		require(
			quote.quoteStatus == QuoteStatus.OPENED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"ADLFacet: Invalid state"
		);

		// Get quote related data
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		require(amount != 0 && amount <= openAmount, "ADLFacet: Invalid amount");

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
		LibAccount.increasePartyBNonce(quote.partyB, quote.partyA);
		accountLayout.partyANonces[quote.partyA] += 1;

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
		closedAmount = amount;

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
			}
		}
	}
}
