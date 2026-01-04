// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage, Quote, OrderType, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibPartyBBatchEvents } from "../../libraries/PartysEvents.sol";
import { ADLReason } from "../../libraries/ADLTypes.sol";

library ADLFacetImpl {
	/**
	 * @notice Auto-deleverages a set of quotes proportionally, checking solvency buffers and preserving pending close intents.
	 * @dev Keeps quote closeIds/status consistent with existing CLOSE_PENDING/CANCEL_CLOSE_PENDING flows and emits ADL events.
	 * @param quoteIds Quotes to ADL close (same partyA/partyB/symbol).
	 * @param amounts Amounts to close per quote (token decimals).
	 * @param prices Execution prices per quote used for the ADL close.
	 */
	function adlClose(
		uint256[] calldata quoteIds,
		uint256[] calldata amounts,
		uint256[] calldata prices
	) internal returns (uint256[] memory filledAmounts, uint256 closedAmount, uint256[] memory closeIds) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		uint256 len = quoteIds.length;
		filledAmounts = new uint256[](len);
		closeIds = new uint256[](len);

		require(quoteIds.length > 0, "PartyBBatchActionsFacet: invalid array length");
		require(amounts.length == len && prices.length == len, "PartyBBatchActionsFacet: invalid array length");

		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address firstQuotePartyB = firstQuote.partyB;

		require(maLayout.adlEnabled[firstQuotePartyB], "PartyBFacet: ADL disabled");
		require(!accountLayout.crossLiquidationDetails[firstQuotePartyB].inProgress, "PartyBFacet: PartyB is in cross liquidation process");

		for (uint256 i = 0; i < len; ) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];

			require(quote.partyB == LibSigner.getSigner(), "PartyBFacet: Sender isn't partyB of quote");
			require(!maLayout.liquidationStatus[quote.partyA], "PartyBFacet: PartyA is liquidated");
			require(!maLayout.partyBLiquidationStatus[quote.partyB][quote.partyA], "PartyBFacet: PartyB is liquidated");
			require(quote.symbolId == firstQuote.symbolId, "PartyBFacet: Symbols not match");

			if (
				quote.quoteStatus != QuoteStatus.OPENED &&
				quote.quoteStatus != QuoteStatus.CLOSE_PENDING &&
				quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING
			) {
				emit LibPartyBBatchEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.NOT_IN_CLOSE_STATE, 0);
				unchecked {
					++i;
				}
				continue;
			}

			// Get quote related data
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			uint256 adlAmount = amounts[i];
			uint256 adlPrice = prices[i];

			// If not enough OpenAmount continue
			if (adlAmount == 0 || openAmount >= adlAmount) {
				// If enough OpenAmount continue With process
				emit LibPartyBBatchEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.INVALID_FILLED_AMOUNT, 0);
				unchecked {
					++i;
				}
				continue;
			}

			// If in any State but Open, reserve state and return to open state
			bool wasClosePending = quote.quoteStatus == QuoteStatus.CLOSE_PENDING;
			bool wasCancelClosePending = quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING;
			uint256 prevRequestedClosePrice;
			uint256 prevRequestedQuantityToClose;
			if (wasClosePending || wasCancelClosePending) {
				uint256 previousCloseId = quoteLayout.closeIds[quote.id];
				prevRequestedClosePrice = quote.requestedClosePrice;
				prevRequestedQuantityToClose = quote.quantityToClose;

				if (wasClosePending) {
					emit LibPartyBBatchEvents.RequestToCancelCloseRequest(
						quote.partyA,
						quote.partyB,
						quote.id,
						QuoteStatus.CANCEL_CLOSE_PENDING,
						previousCloseId
					);
				}
				emit LibPartyBBatchEvents.AcceptCancelCloseRequest(quote.id, QuoteStatus.CANCELED, previousCloseId);
				quote.quantityToClose = 0;
				quote.requestedClosePrice = 0;
				quote.quoteStatus = QuoteStatus.OPENED;
				quote.statusModifyTimestamp = block.timestamp;
			}

			// Fees paid when closing a position
			uint256 closeFee = (adlAmount * adlPrice * quote.closeFee) / 1e36;
			uint256 maintenance = ((quote.lockedValues.cva + quote.lockedValues.lf) * adlAmount) / openAmount;
			uint256 requiredA = maintenance + closeFee;
			uint256 requiredB = maintenance;
			// Who is going to pay the funding
			int256 fundingFee = LibQuoteFunding.getAccumulatedFundingFee(quote.id);
			if (fundingFee > 0) {
				requiredA += uint256(fundingFee);
				requiredB -= uint256(fundingFee);
			} else if (fundingFee < 0) {
				requiredB += uint256(-fundingFee);
				requiredA -= uint256(-fundingFee);
			}

			address allocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
			if (accountLayout.allocatedBalances[quote.partyA] < requiredA) {
				emit LibPartyBBatchEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.PARTY_A_INSUFFICIENT_BALANCE, int256(requiredA));
				unchecked {
					++i;
				}
				continue;
			}

			(bool hasMadeProfit, uint256 pnl) = LibQuote.getValueOfQuoteForPartyA(adlPrice, adlAmount, quote);
			if (hasMadeProfit) requiredB += pnl;
			if (accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] < requiredB) {
				emit LibPartyBBatchEvents.ADLSkip(quote.id, quote.partyA, quote.partyB, ADLReason.PARTY_B_INSUFFICIENT_BALANCE, int256(requiredB));
				unchecked {
					++i;
				}
				continue;
			}

			uint256 adlCloseId = ++quoteLayout.lastCloseId;
			closeIds[i] = adlCloseId;
			quoteLayout.closeIds[quote.id] = adlCloseId;
			quote.quantityToClose = adlAmount;
			quote.requestedClosePrice = adlPrice;
			quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
			emit LibPartyBBatchEvents.RequestToClosePosition(
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
			emit LibPartyBBatchEvents.RequestToClosePosition(
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
			uint256 remainingOpen = LibQuote.quoteOpenAmount(quote);
			closedAmount += adlAmount;
			filledAmounts[i] = adlAmount;

			if ((wasClosePending || wasCancelClosePending) && remainingOpen > 0) {
				uint256 newQuantity = remainingOpen >= prevRequestedQuantityToClose ? prevRequestedQuantityToClose : remainingOpen;
				uint256 newCloseId = ++quoteLayout.lastCloseId;
				quote.quantityToClose = newQuantity;
				quote.requestedClosePrice = prevRequestedClosePrice;
				quote.quoteStatus = wasCancelClosePending ? QuoteStatus.CANCEL_CLOSE_PENDING : QuoteStatus.CLOSE_PENDING;
				quote.statusModifyTimestamp = block.timestamp;
				quoteLayout.closeIds[quote.id] = newCloseId;
				emit LibPartyBBatchEvents.RequestToClosePosition(
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
				emit LibPartyBBatchEvents.RequestToClosePosition(
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
					emit LibPartyBBatchEvents.RequestToCancelCloseRequest(
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
