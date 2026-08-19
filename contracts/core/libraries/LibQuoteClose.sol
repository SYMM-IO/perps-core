// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SharedEvents } from "./SharedEvents.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibQuoteFunding } from "./LibQuoteFunding.sol";
import { LibConnections } from "./LibConnections.sol";
import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { FundingStorage } from "../storages/FundingStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibPartyBState } from "./extensions/LibPartyBState.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";
import { LibSymbolAdjustment } from "./LibSymbolAdjustment.sol";
import { LibSigner } from "./LibSigner.sol";

library LibQuoteClose {
	using LockedValuesOps for LockedValues;
	using LibPartyBState for address;

	struct CloseSettlement {
		int256 fundingFee;
		uint256 pnl;
		address allocationKey;
		bool fundingEnabled;
		bool hasMadeProfit;
	}

	/// @notice Closes a quote.
	/// @param quoteId The ID of the quote to close.
	/// @param filledAmount The filled amount of the quote.
	/// @param closedPrice The price at which the quote is closed.
	function closeQuote(uint256 quoteId, uint256 filledAmount, uint256 closedPrice) public {
		CloseSettlement memory settlement = _prepareCloseQuote(quoteId, filledAmount, closedPrice);
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		(uint256 partyAReceives, uint256 partyAPays) = _partyASettlementAmounts(settlement);
		_requireSettlementBalance(quote, settlement.allocationKey, partyAReceives, partyAPays);
		_applySettlementCredit(quote, settlement);
		_applySettlementDebit(quote, settlement);
		uint256 fee = _finalizeCloseQuote(quoteId, filledAmount, closedPrice, settlement);
		_callCloseQuoteHooks(quoteId, filledAmount, closedPrice, fee);
	}

	/// @notice Closes a batch of quotes after netting every bilateral funding and PnL component.
	/// @dev Duplicate quote IDs are rejected before any state mutation. No external hook is called until every quote has been finalized.
	function closeQuotes(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices
	) public returns (QuoteStatus[] memory quoteStatuses, uint256[] memory closeIds) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
		address partyA = firstQuote.partyA;
		address partyB = firstQuote.partyB;

		_requireUniqueQuoteIds(quoteIds);
		require(!MAStorage.layout().liquidationStatus[partyA], "PartyBFacet: PartyA isn't solvent");
		partyB.requireNotLiquidating(partyA);
		LibAccount.increaseBothUpnlCounters(partyB, partyA);

		CloseSettlement[] memory settlements = new CloseSettlement[](quoteIds.length);
		uint256 partyAReceives;
		uint256 partyAPays;

		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			require(quote.partyB == partyB, "PartyBBatchActionsFacet: All positions must have same partyB");
			require(quote.partyA == partyA, "PartyBBatchActionsFacet: All positions must have same partyA");
			require(quote.partyB == LibSigner.getSigner(), "PartyBFacet: Sender should be the partyB");
			_validateFillCloseRequest(quoteIds[i], filledAmounts[i], closedPrices[i]);
			settlements[i] = _prepareCloseQuote(quoteIds[i], filledAmounts[i], closedPrices[i]);
			(uint256 quoteReceives, uint256 quotePays) = _partyASettlementAmounts(settlements[i]);
			partyAReceives += quoteReceives;
			partyAPays += quotePays;
		}

		_requireSettlementBalance(firstQuote, settlements[0].allocationKey, partyAReceives, partyAPays);

		for (uint256 i = 0; i < quoteIds.length; i++) {
			_applySettlementCredit(QuoteStorage.layout().quotes[quoteIds[i]], settlements[i]);
		}
		for (uint256 i = 0; i < quoteIds.length; i++) {
			_applySettlementDebit(QuoteStorage.layout().quotes[quoteIds[i]], settlements[i]);
		}
		uint256[] memory fees = new uint256[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			fees[i] = _finalizeCloseQuote(quoteIds[i], filledAmounts[i], closedPrices[i], settlements[i]);
		}
		for (uint256 i = 0; i < quoteIds.length; i++) {
			_callCloseQuoteHooks(quoteIds[i], filledAmounts[i], closedPrices[i], fees[i]);
		}

		quoteStatuses = new QuoteStatus[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) {
			quoteStatuses[i] = quoteLayout.quotes[quoteIds[i]].quoteStatus;
			closeIds[i] = quoteLayout.closeIds[quoteIds[i]];
		}
	}

	function _requireUniqueQuoteIds(uint256[] memory quoteIds) private pure {
		for (uint256 i = 0; i < quoteIds.length; i++) {
			for (uint256 j = i + 1; j < quoteIds.length; j++) {
				require(quoteIds[i] != quoteIds[j], "LibQuoteClose: Duplicate quoteId");
			}
		}
	}

	function _validateFillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice) private view {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
		require(
			quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"PartyBFacet: Invalid state"
		);
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");
		if (quote.positionType == PositionType.LONG) {
			require(closedPrice >= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		} else {
			require(closedPrice <= quote.requestedClosePrice, "PartyBFacet: Closed price isn't valid");
		}
		if (quote.orderType == OrderType.LIMIT) {
			require(quote.quantityToClose >= filledAmount, "PartyBFacet: Invalid filledAmount");
		} else {
			require(quote.quantityToClose == filledAmount, "PartyBFacet: Invalid filledAmount");
		}
	}

	function _prepareCloseQuote(uint256 quoteId, uint256 filledAmount, uint256 closedPrice) private returns (CloseSettlement memory settlement) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

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

		settlement.fundingEnabled = FundingStorage.layout().fundingFees[quote.symbolId][quote.partyB].epochDuration > 0;
		settlement.fundingFee = settlement.fundingEnabled ? LibQuoteFunding.recordAccumulatedFundingFee(quoteId) : int256(0);
		(settlement.hasMadeProfit, settlement.pnl) = LibQuote.getValueOfQuoteForPartyA(closedPrice, filledAmount, quote);
		settlement.allocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
	}

	function _finalizeCloseQuote(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		CloseSettlement memory settlement
	) private returns (uint256 fee) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		if (settlement.fundingEnabled) LibQuoteFunding.emitQuoteFundingSettled(quoteId, settlement.allocationKey, settlement.fundingFee);

		quote.avgClosedPrice = (quote.avgClosedPrice * quote.closedAmount + filledAmount * closedPrice) / (quote.closedAmount + filledAmount);

		fee = (filledAmount * closedPrice * quote.closeFee) / 1e36;
		LibAccount.decreasePartyAAllocatedBalance(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_OUT);
		emit SharedEvents.TradingFeeCharged(
			quote.id,
			fee,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradingFeeType.CLOSE
		);

		address feeCollector = LibAccount.getFeeCollector(quote.affiliate);
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
	}

	function _callCloseQuoteHooks(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, uint256 fee) private {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
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

	function _partyASettlementAmounts(CloseSettlement memory settlement) private pure returns (uint256 partyAReceives, uint256 partyAPays) {
		if (settlement.hasMadeProfit) partyAReceives = settlement.pnl;
		else partyAPays = settlement.pnl;

		int256 fundingFee = settlement.fundingFee;
		if (fundingFee < 0) partyAReceives += uint256(-fundingFee);
		else partyAPays += uint256(fundingFee);
	}

	function _requireSettlementBalance(Quote storage quote, address allocationKey, uint256 partyAReceives, uint256 partyAPays) private view {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (partyAReceives > partyAPays) {
			require(
				accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] >= partyAReceives - partyAPays,
				"LibQuote: PartyA should first exit its positions that are incurring losses"
			);
		} else if (partyAPays > partyAReceives) {
			require(
				accountLayout.allocatedBalances[quote.partyA] >= partyAPays - partyAReceives,
				"LibQuote: PartyA should first exit its positions that are currently in profit."
			);
		}
	}

	function _applySettlementCredit(Quote storage quote, CloseSettlement memory settlement) private {
		LibQuoteFunding.creditFundingFee(quote, settlement.allocationKey, settlement.fundingFee);
		if (settlement.hasMadeProfit) {
			LibAccount.increasePartyAAllocatedBalance(quote.partyA, settlement.pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		} else {
			LibAccount.increasePartyBAllocatedBalance(
				quote.partyB,
				settlement.allocationKey,
				settlement.pnl,
				SharedEvents.BalanceChangeType.REALIZED_PNL_IN
			);
		}
	}

	function _applySettlementDebit(Quote storage quote, CloseSettlement memory settlement) private {
		LibQuoteFunding.debitFundingFee(quote, settlement.allocationKey, settlement.fundingFee);
		if (settlement.hasMadeProfit) {
			LibAccount.decreasePartyBAllocatedBalance(
				quote.partyB,
				settlement.allocationKey,
				settlement.pnl,
				SharedEvents.BalanceChangeType.REALIZED_PNL_OUT
			);
		} else {
			LibAccount.decreasePartyAAllocatedBalance(quote.partyA, settlement.pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		}
	}

	/// @notice Expires a quote.
	/// @param quoteId The ID of the quote to expire.
	/// @return result The resulting status of the quote after expiration.
	function expireQuote(uint256 quoteId) public returns (QuoteStatus result) {
		require(block.timestamp > QuoteStorage.layout().quotes[quoteId].deadline, "LibQuote: Quote isn't expired");
		result = forceExpireQuote(quoteId);
	}

	/// @notice expireQuote without the deadline gate — only exposed via privileged facet paths
	function forceExpireQuote(uint256 quoteId) public returns (QuoteStatus result) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(
			quote.quoteStatus == QuoteStatus.PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_PENDING ||
				quote.quoteStatus == QuoteStatus.LOCKED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"LibQuote: Invalid state"
		);
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "LibQuote: PartyA isn't solvent");
		quote.partyB.requireNotLiquidating(quote.partyA);

		if (quote.quoteStatus == QuoteStatus.PENDING || quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
			quote.statusModifyTimestamp = block.timestamp;
			accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);

			// send trading Fee back to partyA
			LibAccount.refundOpenTradingFee(quote.id, quote.partyA);

			LibQuote.removeFromPartyAPendingQuotes(quote);
			if (quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
				LibAccount.subFromPartyBPendingLockedBalances(quote);
				LibQuote.removeFromPartyBPendingQuotes(quote);
				LibConnections.removeConnectionIfNoPositions(quote.partyA, quote.partyB);
			}

			quote.quoteStatus = QuoteStatus.EXPIRED;
			result = QuoteStatus.EXPIRED;

			LibHook.callCancelQuoteHooks(quoteId, quote.partyA, quote.partyB, quote.affiliate);
		} else if (quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING) {
			quote.statusModifyTimestamp = block.timestamp;
			quote.requestedClosePrice = 0;
			quote.quantityToClose = 0;
			quote.quoteStatus = QuoteStatus.OPENED;
			result = QuoteStatus.OPENED;
			LibHook.callCloseExpiredHooks(quoteId, quote.partyA, quote.partyB, quote.affiliate);
		}
	}
}
