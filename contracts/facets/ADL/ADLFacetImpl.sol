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
import { ADLReason } from "../../libraries/LibPartiesEvents.sol";

library ADLFacetImpl {
	/**
	 * @notice Auto-deleverages a set of quotes proportionally, checking solvency buffers and preserving pending close intents.
	 * @dev Keeps quote closeIds/status consistent with existing CLOSE_PENDING/CANCEL_CLOSE_PENDING flows and emits ADL events.
	 * @param quoteIds Quotes to ADL close (same partyA/partyB/symbol).
	 * @param amounts Amounts to close per quote (token decimals).
	 * @param prices Execution prices per quote used for the ADL close.
	 */
	function adlClose(uint256[] calldata quoteIds, uint256[] calldata amounts, uint256[] calldata prices) internal returns (uint256 closedAmount) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		uint256 len = quoteIds.length;

		require(quoteIds.length > 0, "ADLFacet: Invalid array length");
		require(amounts.length == len && prices.length == len, "ADLFacet: Invalid array length");

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address signer = LibSigner.getSigner();

		require(firstQuote.partyB == signer, "ADLFacet: Sender isn't partyB of quote");
		require(maLayout.adlEnabled[signer], "ADLFacet: ADL disabled");
		require(!accountLayout.crossLiquidationDetails[signer].inProgress, "ADLFacet: PartyB is in cross liquidation process");

		for (uint256 i = 0; i < len; ) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];

			require(quote.partyB == signer, "ADLFacet: Sender isn't partyB of quote");
			// If PartyA is already in liquidation process, ADL should skip (positions must be handled via liquidation/settlement flow).
			if (maLayout.liquidationStatus[quote.partyA]) {
				emit LibPartiesEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.NOT_IN_CLOSE_STATE, 0);
				unchecked {
					++i;
				}
				continue;
			}
			require(!maLayout.partyBLiquidationStatus[quote.partyB][quote.partyA], "ADLFacet: PartyB is liquidated");
			require(quote.symbolId == firstQuote.symbolId, "ADLFacet: Symbols not match");

			if (
				quote.quoteStatus != QuoteStatus.OPENED &&
				quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
				quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
			) {
				emit LibPartiesEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.NOT_IN_CLOSE_STATE, 0);
				unchecked {
					++i;
				}
				continue;
			}

			// Get quote related data
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			uint256 adlAmount = amounts[i];
			uint256 adlPrice = prices[i];

			// Skip invalid amounts
			if (adlAmount == 0 || adlAmount > openAmount) {
				emit LibPartiesEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.INVALID_FILLED_AMOUNT, 0);
				unchecked {
					++i;
				}
				continue;
			}

			// Ensure `closeQuote` (including funding fee charge) won't revert; otherwise skip without mutating state.
			(LibQuoteClose.CloseQuoteCheckResult checkResult, uint256 requiredAmount) = LibQuoteClose.checkCloseQuote(quote.id, adlAmount, adlPrice);
			if (checkResult != LibQuoteClose.CloseQuoteCheckResult.OK) {
				if (
					checkResult == LibQuoteClose.CloseQuoteCheckResult.INVALID_FILLED_AMOUNT ||
					checkResult == LibQuoteClose.CloseQuoteCheckResult.LOW_FILLED_AMOUNT
				) {
					emit LibPartiesEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.INVALID_FILLED_AMOUNT, 0);
				} else if (checkResult == LibQuoteClose.CloseQuoteCheckResult.PARTY_A_INSUFFICIENT_BALANCE) {
					emit LibPartiesEvents.ADLSkip(
						quote.id,
						quote.partyA,
						quote.partyB,
						ADLReason.PARTY_A_INSUFFICIENT_BALANCE,
						int256(requiredAmount)
					);
				} else {
					emit LibPartiesEvents.ADLSkip(
						quote.id,
						quote.partyA,
						quote.partyB,
						ADLReason.PARTY_B_INSUFFICIENT_BALANCE,
						int256(requiredAmount)
					);
				}
				unchecked {
					++i;
				}
				continue;
			}

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
			quote.quantityToClose = adlAmount;
			quote.requestedClosePrice = adlPrice;
			quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
			quote.statusModifyTimestamp = block.timestamp;
			emit LibPartiesEvents.RequestToClosePosition(
				quote.partyA,
				quote.partyB,
				quote.id,
				adlPrice,
				adlAmount,
				OrderType.MARKET,
				block.timestamp,
				QuoteStatus.CLOSE_PENDING,
				adlCloseId
			);
			emit LibPartiesEvents.RequestToClosePosition(
				quote.partyA,
				quote.partyB,
				quote.id,
				adlPrice,
				adlAmount,
				OrderType.MARKET,
				block.timestamp,
				QuoteStatus.CLOSE_PENDING
			);

			//Update nonce
			LibAccount.increasePartyBNonce(quote.partyB, quote.partyA);
			accountLayout.partyANonces[quote.partyA] += 1;

			LibQuoteClose.closeQuote(quote.id, adlAmount, adlPrice);
			emit LibPartiesEvents.FillCloseRequest(quote.id, quote.partyA, quote.partyB, adlAmount, adlPrice, quote.quoteStatus, adlCloseId);
			emit LibPartiesEvents.FillCloseRequest(
				quote.id,
				quote.partyA,
				quote.partyB,
				adlAmount,
				adlPrice,
				quote.quoteStatus,
				adlCloseId,
				quote.lockedValues
			);
			uint256 remainingOpen = LibQuote.quoteOpenAmount(quote);
			closedAmount += adlAmount;

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
					emit LibPartiesEvents.RequestToCancelCloseRequest(
						quote.partyA,
						quote.partyB,
						quote.id,
						QuoteStatus.CANCEL_CLOSE_PENDING,
						newCloseId
					);
				}
			}
			unchecked {
				++i;
			}
		}
	}
}
