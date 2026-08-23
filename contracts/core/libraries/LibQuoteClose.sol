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
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { FundingStorage } from "../storages/FundingStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibPartyBState } from "./extensions/LibPartyBState.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";

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

	/// @notice Runs expireQuote without the deadline gate and is exposed only through privileged facet paths.
	function forceExpireQuote(uint256 quoteId) public returns (QuoteStatus result) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		require(
			_isPendingQuoteStatus(quote.quoteStatus) ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"LibQuote: Invalid state"
		);
		_requireNotLiquidating(quote);

		if (_isPendingQuoteStatus(quote.quoteStatus)) {
			_removePendingQuote(quote, QuoteStatus.EXPIRED);
			result = QuoteStatus.EXPIRED;
		} else if (quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING) {
			quote.statusModifyTimestamp = block.timestamp;
			quote.requestedClosePrice = 0;
			quote.quantityToClose = 0;
			quote.quoteStatus = QuoteStatus.OPENED;
			result = QuoteStatus.OPENED;
			LibHook.callCloseExpiredHooks(quoteId, quote.partyA, quote.partyB, quote.affiliate);
		}
	}

	/// @notice Cancels pending inventory without a deadline gate and is exposed only through the symbol-adjustment manager path.
	function forceCancelPendingQuote(uint256 quoteId) public returns (QuoteStatus result) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(_isPendingQuoteStatus(quote.quoteStatus), "LibQuote: Invalid state");
		_requireNotLiquidating(quote);
		_removePendingQuote(quote, QuoteStatus.CANCELED);
		result = QuoteStatus.CANCELED;
	}

	function _removePendingQuote(Quote storage quote, QuoteStatus terminalStatus) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		bool hasPartyBLock = quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING;

		quote.statusModifyTimestamp = block.timestamp;
		accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);

		// send trading Fee back to partyA
		LibAccount.refundOpenTradingFee(quote.id, quote.partyA);

		LibQuote.removeFromPartyAPendingQuotes(quote);
		if (hasPartyBLock) {
			LibAccount.subFromPartyBPendingLockedBalances(quote);
			LibQuote.removeFromPartyBPendingQuotes(quote);
			LibConnections.removeConnectionIfNoPositions(quote.partyA, quote.partyB);
		}

		quote.quoteStatus = terminalStatus;
		LibHook.callCancelQuoteHooks(quote.id, quote.partyA, quote.partyB, quote.affiliate);
	}

	function _isPendingQuoteStatus(QuoteStatus quoteStatus) private pure returns (bool) {
		return quoteStatus == QuoteStatus.PENDING || quoteStatus == QuoteStatus.CANCEL_PENDING || quoteStatus == QuoteStatus.LOCKED;
	}

	function _requireNotLiquidating(Quote storage quote) private view {
		require(!MAStorage.layout().liquidationStatus[quote.partyA], "LibQuote: PartyA isn't solvent");
		quote.partyB.requireNotLiquidating(quote.partyA);
	}
}
