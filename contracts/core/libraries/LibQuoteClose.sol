// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SharedEvents } from "./SharedEvents.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibQuoteFunding } from "./LibQuoteFunding.sol";
import { LibConnections } from "./LibConnections.sol";
import { QuoteStorage, Quote, LockedValues, QuoteStatus } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { FundingStorage } from "../storages/FundingStorage.sol";
import { ClearingHouseStorage } from "../storages/ClearingHouseStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { LibAccount } from "./LibAccount.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";

library LibQuoteClose {
	using LockedValuesOps for LockedValues;

	/**
	 * @notice Closes a quote.
	 * @param quoteId The ID of the quote to close.
	 * @param filledAmount The filled amount of the quote.
	 * @param closedPrice The price at which the quote is closed.
	 */
	function closeQuote(uint256 quoteId, uint256 filledAmount, uint256 closedPrice) public {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];

		require(
			quote.lockedValues.cva == 0 || (quote.lockedValues.cva * filledAmount) / LibQuote.quoteOpenAmount(quote) > 0,
			"LibQuote: Low filled amount"
		);
		require(
			quote.lockedValues.partyAmm == 0 || (quote.lockedValues.partyAmm * filledAmount) / LibQuote.quoteOpenAmount(quote) > 0,
			"LibQuote: Low filled amount"
		);
		require(
			quote.lockedValues.partyBmm == 0 || (quote.lockedValues.partyBmm * filledAmount) / LibQuote.quoteOpenAmount(quote) > 0,
			"LibQuote: Low filled amount"
		);
		require((quote.lockedValues.lf * filledAmount) / LibQuote.quoteOpenAmount(quote) > 0, "LibQuote: Low filled amount");
		LockedValues memory lockedValues = LockedValues(
			quote.lockedValues.cva - ((quote.lockedValues.cva * filledAmount) / (LibQuote.quoteOpenAmount(quote))),
			quote.lockedValues.lf - ((quote.lockedValues.lf * filledAmount) / (LibQuote.quoteOpenAmount(quote))),
			quote.lockedValues.partyAmm - ((quote.lockedValues.partyAmm * filledAmount) / (LibQuote.quoteOpenAmount(quote))),
			quote.lockedValues.partyBmm - ((quote.lockedValues.partyBmm * filledAmount) / (LibQuote.quoteOpenAmount(quote)))
		);

		accountLayout.lockedBalances[quote.partyA].subQuote(quote).add(lockedValues);
		LibAccount.updatePartyBLockedBalances(quote, lockedValues);
		quote.lockedValues = lockedValues;

		if (LibQuote.quoteOpenAmount(quote) == quote.quantityToClose) {
			require(
				quote.lockedValues.totalForPartyA() == 0 ||
					quote.lockedValues.totalForPartyA() >= symbolLayout.symbols[quote.symbolId].minAcceptableQuoteValue,
				"LibQuote: Remaining quote value is low"
			);
		}

		if (FundingStorage.layout().fundingFees[quote.symbolId][quote.partyB].epochDuration > 0) {
			LibQuoteFunding.chargeAccumulatedFundingFee(quoteId);
		}

		(bool hasMadeProfit, uint256 pnl) = LibQuote.getValueOfQuoteForPartyA(closedPrice, filledAmount, quote);
		address allocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
		if (hasMadeProfit) {
			require(
				accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] >= pnl,
				"LibQuote: PartyA should first exit its positions that are incurring losses"
			);
			accountLayout.allocatedBalances[quote.partyA] += pnl;
			emit SharedEvents.BalanceChangePartyA(quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] -= pnl;
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		} else {
			require(
				accountLayout.allocatedBalances[quote.partyA] >= pnl,
				"LibQuote: PartyA should first exit its positions that are currently in profit."
			);
			accountLayout.allocatedBalances[quote.partyA] -= pnl;
			emit SharedEvents.BalanceChangePartyA(quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] += pnl;
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		}

		quote.avgClosedPrice = (quote.avgClosedPrice * quote.closedAmount + filledAmount * closedPrice) / (quote.closedAmount + filledAmount);

		uint256 fee = (filledAmount * closedPrice * quote.closeFee) / 1e36;
		accountLayout.allocatedBalances[quote.partyA] -= fee;
		emit SharedEvents.BalanceChangePartyA(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_OUT);
		emit SharedEvents.TradingFeeCharged(
			quote.id,
			fee,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradingFeeType.CLOSE
		);

		address feeCollector = appLayout.affiliateFeeCollector[quote.affiliate] == address(0)
			? appLayout.defaultFeeCollector
			: appLayout.affiliateFeeCollector[quote.affiliate];
		accountLayout.balances[feeCollector] += fee;
		quote.closedAmount += filledAmount;
		LibQuote.subFromPartiesAggregatedPositions(quote, filledAmount);
		quote.quantityToClose -= filledAmount;

		if (quote.closedAmount == quote.quantity) {
			quote.statusModifyTimestamp = block.timestamp;
			quote.quoteStatus = QuoteStatus.CLOSED;
			quote.requestedClosePrice = 0;
			LibQuote.removeFromOpenPositions(quote.id);
			LibConnections.removeConnectionIfNoPositions(quote.partyA, quote.partyB);
		} else if (quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING || quote.quantityToClose == 0) {
			quote.quoteStatus = QuoteStatus.OPENED;
			quote.statusModifyTimestamp = block.timestamp;
			quote.requestedClosePrice = 0;
			quote.quantityToClose = 0; // for CANCEL_CLOSE_PENDING status
		}

		{
			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];

			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, filledAmount, closedPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(
					ISymmioHook.onFeeCharged,
					(quote.id, fee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.CLOSE)
				),
				quote.id
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, filledAmount, closedPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(
					ISymmioHook.onFeeCharged,
					(quote.id, fee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.CLOSE)
				),
				quote.id
			);
		}

		emit SharedEvents.TradeVolumeRecorded(
			quote.id,
			(filledAmount * closedPrice) / 1e18,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradeVolumeType.CLOSE
		);
	}

	/**
	 * @notice Expires a quote.
	 * @param quoteId The ID of the quote to expire.
	 * @return result The resulting status of the quote after expiration.
	 */
	function expireQuote(uint256 quoteId) public returns (QuoteStatus result) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(block.timestamp > quote.deadline, "LibQuote: Quote isn't expired");
		require(
			quote.quoteStatus == QuoteStatus.PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_PENDING ||
				quote.quoteStatus == QuoteStatus.LOCKED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"LibQuote: Invalid state"
		);
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "LibQuote: PartyA isn't solvent");
		require(!MAStorage.layout().partyBLiquidationStatus[quote.partyB][quote.partyA], "LibQuote: PartyB isn't solvent");
		require(!ClearingHouseStorage.layout().crossLiquidationDetails[quote.partyB].inProgress, "LibQuote: PartyB is in cross liquidation process");

		if (quote.quoteStatus == QuoteStatus.PENDING || quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
			quote.statusModifyTimestamp = block.timestamp;
			accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);

			// send trading Fee back to partyA
			LibAccount.refundOpenTradingFee(quote.id, quote.partyA);

			LibQuote.removeFromPartyAPendingQuotes(quote);
			if (quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
				LibAccount.subFromPartyBPendingLockedBalances(quote);
				LibQuote.removeFromPartyBPendingQuotes(quote);
			}

			quote.quoteStatus = QuoteStatus.EXPIRED;
			result = QuoteStatus.EXPIRED;

			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];

			LibHook.safeCall(affiliateHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quoteId, quote.partyA, quote.partyB)), quoteId);
			LibHook.safeCall(systemHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quoteId, quote.partyA, quote.partyB)), quoteId);
		} else if (quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING) {
			quote.statusModifyTimestamp = block.timestamp;
			quote.requestedClosePrice = 0;
			quote.quantityToClose = 0;
			quote.quoteStatus = QuoteStatus.OPENED;
			result = QuoteStatus.OPENED;
		}
	}
}
