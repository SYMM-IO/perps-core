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
import { LibPartiesEvents, ADLReason } from "../../libraries/LibPartiesEvents.sol";

library ADLFacetImpl {
	/// @notice Result of processing a single ADL quote
	struct ProcessResult {
		bool success;
		uint256 closedAmount;
		ADLReason skipReason;
		int256 skipData;
	}

	/**
	 * @notice Auto-deleverages a set of quotes, skipping any that fail validation.
	 * @param quoteIds Quotes to ADL close (same partyB/symbol).
	 * @param amounts Amounts to close per quote.
	 * @param prices Execution prices per quote.
	 */
	function adlClose(uint256[] calldata quoteIds, uint256[] calldata amounts, uint256[] calldata prices) internal returns (uint256 closedAmount) {
		uint256 len = quoteIds.length;
		require(len > 0 && amounts.length == len && prices.length == len, "ADLFacet: Invalid array length");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address signer = LibSigner.getSigner();

		require(firstQuote.partyB == signer, "ADLFacet: Sender isn't partyB of quote");
		require(maLayout.adlEnabled[signer], "ADLFacet: ADL disabled");
		require(!AccountStorage.layout().crossLiquidationDetails[signer].inProgress, "ADLFacet: PartyB is in cross liquidation process");

		for (uint256 i = 0; i < len; ) {
			ProcessResult memory result = _processQuote(quoteIds[i], amounts[i], prices[i], firstQuote.symbolId, signer);

			if (result.success) {
				closedAmount += result.closedAmount;
			} else {
				Quote storage quote = quoteLayout.quotes[quoteIds[i]];
				emit LibPartiesEvents.ADLSkip(quoteIds[i], quote.partyA, quote.partyB, result.skipReason, result.skipData);
			}

			unchecked { ++i; }
		}
	}

	/**
	 * @notice Processes a single quote for ADL close.
	 * @dev Validates the quote and executes the close if valid.
	 * @return result The processing result including success status and closed amount or skip reason.
	 */
	function _processQuote(
		uint256 quoteId,
		uint256 amount,
		uint256 price,
		uint256 requiredSymbolId,
		address signer
	) private returns (ProcessResult memory result) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		// Validation checks - return early with skip reason if any fail
		if (quote.partyB != signer) {
			return ProcessResult(false, 0, ADLReason.NOT_IN_CLOSE_STATE, 0);
		}

		if (maLayout.liquidationStatus[quote.partyA]) {
			return ProcessResult(false, 0, ADLReason.IN_LIQUIDATION, 0);
		}

		if (maLayout.partyBLiquidationStatus[quote.partyB][quote.partyA]) {
			return ProcessResult(false, 0, ADLReason.IN_LIQUIDATION, 0);
		}

		if (quote.symbolId != requiredSymbolId) {
			return ProcessResult(false, 0, ADLReason.SYMBOL_MISMATCH, 0);
		}

		if (
			quote.quoteStatus != QuoteStatus.OPENED &&
			quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
			quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
		) {
			return ProcessResult(false, 0, ADLReason.NOT_IN_CLOSE_STATE, 0);
		}

		uint256 openAmount = LibQuote.quoteOpenAmount(quote);
		if (amount == 0 || amount > openAmount) {
			return ProcessResult(false, 0, ADLReason.INVALID_FILLED_AMOUNT, 0);
		}

		// Check if close would succeed
		(LibQuoteClose.CloseQuoteCheckResult checkResult, uint256 requiredAmount) = LibQuoteClose.checkCloseQuote(quoteId, amount, price);
		if (checkResult != LibQuoteClose.CloseQuoteCheckResult.OK) {
			return _mapCheckResultToSkip(checkResult, requiredAmount);
		}

		// Execute the ADL close
		uint256 closedAmount = _executeClose(quote, quoteId, amount, price);
		return ProcessResult(true, closedAmount, ADLReason.NOT_IN_CLOSE_STATE, 0); // skipReason unused on success
	}

	/**
	 * @notice Maps a LibQuoteClose check result to an ADL skip result.
	 */
	function _mapCheckResultToSkip(
		LibQuoteClose.CloseQuoteCheckResult checkResult,
		uint256 requiredAmount
	) private pure returns (ProcessResult memory) {
		if (
			checkResult == LibQuoteClose.CloseQuoteCheckResult.INVALID_FILLED_AMOUNT ||
			checkResult == LibQuoteClose.CloseQuoteCheckResult.LOW_FILLED_AMOUNT
		) {
			return ProcessResult(false, 0, ADLReason.INVALID_FILLED_AMOUNT, 0);
		} else if (checkResult == LibQuoteClose.CloseQuoteCheckResult.PARTY_A_INSUFFICIENT_BALANCE) {
			return ProcessResult(false, 0, ADLReason.PARTY_A_INSUFFICIENT_BALANCE, int256(requiredAmount));
		} else {
			return ProcessResult(false, 0, ADLReason.PARTY_B_INSUFFICIENT_BALANCE, int256(requiredAmount));
		}
	}

	/**
	 * @notice Executes the actual ADL close for a validated quote.
	 * @dev Handles pending close state preservation and restoration.
	 */
	function _executeClose(Quote storage quote, uint256 quoteId, uint256 amount, uint256 price) private returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		// Preserve pending close state if applicable
		bool wasClosePending = quote.quoteStatus == QuoteStatus.CLOSE_PENDING;
		bool wasCancelClosePending = quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING;
		uint256 prevRequestedClosePrice;
		uint256 prevRequestedQuantityToClose;
		uint256 previousCloseId;

		if (wasClosePending || wasCancelClosePending) {
			previousCloseId = quoteLayout.closeIds[quoteId];
			prevRequestedClosePrice = quote.requestedClosePrice;
			prevRequestedQuantityToClose = quote.quantityToClose;

			if (wasClosePending) {
				emit LibPartiesEvents.RequestToCancelCloseRequest(
					quote.partyA,
					quote.partyB,
					quoteId,
					QuoteStatus.CANCEL_CLOSE_PENDING,
					previousCloseId
				);
			}
			emit LibPartiesEvents.AcceptCancelCloseRequest(quoteId, QuoteStatus.CANCELED, previousCloseId);
			quote.quantityToClose = 0;
			quote.requestedClosePrice = 0;
			quote.quoteStatus = QuoteStatus.OPENED;
			quote.statusModifyTimestamp = block.timestamp;
		}

		// Create ADL close request
		uint256 adlCloseId = ++quoteLayout.lastCloseId;
		quoteLayout.closeIds[quoteId] = adlCloseId;
		quote.quantityToClose = amount;
		quote.requestedClosePrice = price;
		quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
		quote.statusModifyTimestamp = block.timestamp;

		emit LibPartiesEvents.RequestToClosePosition(
			quote.partyA, quote.partyB, quoteId, price, amount,
			OrderType.MARKET, block.timestamp, QuoteStatus.CLOSE_PENDING, adlCloseId
		);
		emit LibPartiesEvents.RequestToClosePosition(
			quote.partyA, quote.partyB, quoteId, price, amount,
			OrderType.MARKET, block.timestamp, QuoteStatus.CLOSE_PENDING
		);

		// Update nonces
		LibAccount.increasePartyBNonce(quote.partyB, quote.partyA);
		accountLayout.partyANonces[quote.partyA] += 1;

		// Execute close
		LibQuoteClose.closeQuote(quoteId, amount, price);

		emit LibPartiesEvents.FillCloseRequest(quoteId, quote.partyA, quote.partyB, amount, price, quote.quoteStatus, adlCloseId);
		emit LibPartiesEvents.FillCloseRequest(quoteId, quote.partyA, quote.partyB, amount, price, quote.quoteStatus, adlCloseId, quote.lockedValues);

		// Restore pending close if there's remaining open amount
		uint256 remainingOpen = LibQuote.quoteOpenAmount(quote);
		if ((wasClosePending || wasCancelClosePending) && remainingOpen > 0) {
			_restorePendingClose(quote, quoteId, remainingOpen, prevRequestedClosePrice, prevRequestedQuantityToClose, wasCancelClosePending);
		}

		return amount;
	}

	/**
	 * @notice Restores a pending close request after partial ADL close.
	 */
	function _restorePendingClose(
		Quote storage quote,
		uint256 quoteId,
		uint256 remainingOpen,
		uint256 prevRequestedClosePrice,
		uint256 prevRequestedQuantityToClose,
		bool wasCancelClosePending
	) private {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		uint256 newQuantity = remainingOpen >= prevRequestedQuantityToClose ? prevRequestedQuantityToClose : remainingOpen;
		uint256 newCloseId = ++quoteLayout.lastCloseId;

		quote.quantityToClose = newQuantity;
		quote.requestedClosePrice = prevRequestedClosePrice;
		quote.quoteStatus = wasCancelClosePending ? QuoteStatus.CANCEL_CLOSE_PENDING : QuoteStatus.CLOSE_PENDING;
		quote.statusModifyTimestamp = block.timestamp;
		quoteLayout.closeIds[quoteId] = newCloseId;

		emit LibPartiesEvents.RequestToClosePosition(
			quote.partyA, quote.partyB, quoteId, prevRequestedClosePrice, newQuantity,
			quote.orderType, block.timestamp, QuoteStatus.CLOSE_PENDING, newCloseId
		);
		emit LibPartiesEvents.RequestToClosePosition(
			quote.partyA, quote.partyB, quoteId, prevRequestedClosePrice, newQuantity,
			quote.orderType, block.timestamp, QuoteStatus.CLOSE_PENDING
		);

		if (wasCancelClosePending) {
			emit LibPartiesEvents.RequestToCancelCloseRequest(
				quote.partyA, quote.partyB, quoteId,
				QuoteStatus.CANCEL_CLOSE_PENDING, newCloseId
			);
		}
	}
}
