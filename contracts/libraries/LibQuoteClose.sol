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
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { LibAccount } from "./LibAccount.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";

library LibQuoteClose {
	using LockedValuesOps for LockedValues;

	/// @dev Helper enum for callers that want to pre-validate `closeQuote` without risking a full-tx revert.
	enum CloseQuoteCheckResult {
		OK,
		INVALID_FILLED_AMOUNT,
		LOW_FILLED_AMOUNT,
		PARTY_A_INSUFFICIENT_BALANCE,
		PARTY_B_INSUFFICIENT_BALANCE
	}

	/**
	 * @notice Checks whether `closeQuote` would succeed without reverting.
	 * @dev Mirrors the balance/rounding constraints in `closeQuote` and `chargeAccumulatedFundingFee`.
	 * @param quoteId The quote to close.
	 * @param filledAmount The amount to close.
	 * @param closedPrice The close price.
	 * @return result The first failing check (or OK).
	 * @return requiredAmount The amount required to satisfy the failing check (0 when not applicable).
	 */
	function checkCloseQuote(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice
	) internal view returns (CloseQuoteCheckResult result, uint256 requiredAmount) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);

		if (filledAmount == 0 || filledAmount > openAmount) {
			return (CloseQuoteCheckResult.INVALID_FILLED_AMOUNT, 0);
		}

		// Same rounding constraints as in `closeQuote` ("Low filled amount")
		if (quote.lockedValues.cva != 0 && (quote.lockedValues.cva * filledAmount) / openAmount == 0) {
			return (CloseQuoteCheckResult.LOW_FILLED_AMOUNT, 0);
		}
		if (quote.lockedValues.partyAmm != 0 && (quote.lockedValues.partyAmm * filledAmount) / openAmount == 0) {
			return (CloseQuoteCheckResult.LOW_FILLED_AMOUNT, 0);
		}
		if (quote.lockedValues.partyBmm != 0 && (quote.lockedValues.partyBmm * filledAmount) / openAmount == 0) {
			return (CloseQuoteCheckResult.LOW_FILLED_AMOUNT, 0);
		}
		if ((quote.lockedValues.lf * filledAmount) / openAmount == 0) {
			return (CloseQuoteCheckResult.LOW_FILLED_AMOUNT, 0);
		}

		uint256 partyAAllocated = accountLayout.allocatedBalances[quote.partyA];
		address allocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
		uint256 partyBAllocated = accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey];
		uint256 partyBLockedCva = accountLayout.partyBLockedBalances[quote.partyB][allocationKey].cva;
		uint256 partyBLockedLf = accountLayout.partyBLockedBalances[quote.partyB][allocationKey].lf;

		// Aggregate A<->B transfers (funding + realized PnL) so opposing flows can net out.
		// This mirrors the net settlement logic in `closeQuote`.
		uint256 partyAToB;
		uint256 partyBToA;

		// Funding fee (positive = PartyA pays PartyB, negative = PartyB pays PartyA)
		int256 fundingFee = LibQuoteFunding.getAccumulatedFundingFee(quoteId);
		if (fundingFee > 0) {
			partyAToB += uint256(fundingFee);
		} else if (fundingFee < 0) {
			partyBToA += uint256(-fundingFee);
		}

		// Realized PnL
		(bool hasMadeProfit, uint256 pnl) = LibQuote.getValueOfQuoteForPartyA(closedPrice, filledAmount, quote);
		if (hasMadeProfit) {
			partyBToA += pnl;
		} else {
			partyAToB += pnl;
		}

		// Net settlement between PartyA and PartyB
		if (partyAToB > partyBToA) {
			uint256 netToB = partyAToB - partyBToA;
			if (partyAAllocated < netToB) return (CloseQuoteCheckResult.PARTY_A_INSUFFICIENT_BALANCE, netToB);
			partyAAllocated -= netToB;
			partyBAllocated += netToB;
		} else if (partyBToA > partyAToB) {
			uint256 netToA = partyBToA - partyAToB;
			if (partyBAllocated < netToA) return (CloseQuoteCheckResult.PARTY_B_INSUFFICIENT_BALANCE, netToA);
			partyBAllocated -= netToA;
			partyAAllocated += netToA;
		}

		// PartyB must remain solvent w.r.t. its locked CVA/LF after this close.
		// (i.e., don't allow paying out using locked CVA/LF)
		{
			uint256 unlockedCva = (quote.lockedValues.cva * filledAmount) / openAmount;
			uint256 unlockedLf = (quote.lockedValues.lf * filledAmount) / openAmount;
			if (partyBLockedCva < unlockedCva || partyBLockedLf < unlockedLf) {
				return (CloseQuoteCheckResult.PARTY_B_INSUFFICIENT_BALANCE, 0);
			}
			uint256 lockedAfter = (partyBLockedCva - unlockedCva) + (partyBLockedLf - unlockedLf);
			if (partyBAllocated < lockedAfter) return (CloseQuoteCheckResult.PARTY_B_INSUFFICIENT_BALANCE, lockedAfter - partyBAllocated);
		}

		// Close trading fee is charged after PnL in `closeQuote`
		uint256 fee = (filledAmount * closedPrice * quote.closeFee) / 1e36;
		if (partyAAllocated < fee) return (CloseQuoteCheckResult.PARTY_A_INSUFFICIENT_BALANCE, fee);

		return (CloseQuoteCheckResult.OK, 0);
	}

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
		uint256 openAmount = LibQuote.quoteOpenAmount(quote);

		require(quote.lockedValues.cva == 0 || (quote.lockedValues.cva * filledAmount) / openAmount > 0, "LibQuote: Low filled amount");
		require(quote.lockedValues.partyAmm == 0 || (quote.lockedValues.partyAmm * filledAmount) / openAmount > 0, "LibQuote: Low filled amount");
		require(quote.lockedValues.partyBmm == 0 || (quote.lockedValues.partyBmm * filledAmount) / openAmount > 0, "LibQuote: Low filled amount");
		require((quote.lockedValues.lf * filledAmount) / openAmount > 0, "LibQuote: Low filled amount");

		uint256 unlockedCva = (quote.lockedValues.cva * filledAmount) / openAmount;
		uint256 unlockedLf = (quote.lockedValues.lf * filledAmount) / openAmount;
		uint256 unlockedPartyAmm = (quote.lockedValues.partyAmm * filledAmount) / openAmount;
		uint256 unlockedPartyBmm = (quote.lockedValues.partyBmm * filledAmount) / openAmount;

		LockedValues memory lockedValues = LockedValues(
			quote.lockedValues.cva - unlockedCva,
			quote.lockedValues.lf - unlockedLf,
			quote.lockedValues.partyAmm - unlockedPartyAmm,
			quote.lockedValues.partyBmm - unlockedPartyBmm
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

		address allocationKey = LibAccount.partyBAllocationKey(quote.partyB, quote.partyA);
		uint256 partyAToB;
		uint256 partyBToA;

		if (symbolLayout.fundingFees[quote.symbolId][quote.partyB].epochDuration > 0) {
			// Mirror `LibQuoteFunding.chargeAccumulatedFundingFee` bookkeeping, but defer balance updates
			// to a net settlement step together with realized PnL.
			int256 fundingFee = LibQuoteFunding.settleAccumulatedFundingFee(quoteId);
			if (fundingFee > 0) {
				uint256 feeInUint = uint256(fundingFee);
				partyAToB += feeInUint;
				emit SharedEvents.BalanceChangePartyA(quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_OUT);
				emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_IN);
			} else if (fundingFee < 0) {
				uint256 feeInUint = uint256(-fundingFee);
				partyBToA += feeInUint;
				emit SharedEvents.BalanceChangePartyA(quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_IN);
				emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, feeInUint, SharedEvents.BalanceChangeType.FUNDING_FEE_OUT);
			}
		}

		(bool hasMadeProfit, uint256 pnl) = LibQuote.getValueOfQuoteForPartyA(closedPrice, filledAmount, quote);
		if (hasMadeProfit) {
			partyBToA += pnl;
			emit SharedEvents.BalanceChangePartyA(quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		} else {
			partyAToB += pnl;
			emit SharedEvents.BalanceChangePartyA(quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, pnl, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		}

		if (partyAToB > partyBToA) {
			uint256 netToB = partyAToB - partyBToA;
			require(
				accountLayout.allocatedBalances[quote.partyA] >= netToB,
				"LibQuote: PartyA should first exit its positions that are currently in profit."
			);
			accountLayout.allocatedBalances[quote.partyA] -= netToB;
			accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] += netToB;
		} else if (partyBToA > partyAToB) {
			uint256 netToA = partyBToA - partyAToB;
			require(
				accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] >= netToA,
				"LibQuote: PartyA should first exit its positions that are incurring losses"
			);
			accountLayout.allocatedBalances[quote.partyA] += netToA;
			accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey] -= netToA;
		}

		{
			uint256 partyBAllocated = accountLayout.partyBAllocatedBalances[quote.partyB][allocationKey];
			uint256 partyBLocked = accountLayout.partyBLockedBalances[quote.partyB][allocationKey].cva +
				accountLayout.partyBLockedBalances[quote.partyB][allocationKey].lf;
			require(partyBAllocated >= partyBLocked, "LibQuote: PartyB should be solvent");
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
			quoteLayout.partyAPositionsCount[quote.partyA] -= 1;
			quoteLayout.partyBPositionsCount[quote.partyB][quote.partyA] -= 1;
			quoteLayout.partyBPositionsCount[quote.partyB][address(0)] -= 1;
			LibConnections.removeConnectionIfNoPositions(quote.partyA, quote.partyB);
		} else if (quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING || quote.quantityToClose == 0) {
			quote.quoteStatus = QuoteStatus.OPENED;
			quote.statusModifyTimestamp = block.timestamp;
			quote.requestedClosePrice = 0;
			quote.quantityToClose = 0; // for CANCEL_CLOSE_PENDING status
		}

		{
			address affiliateHook = accountLayout.affiliateHooks[quote.affiliate];
			address systemHook = accountLayout.affiliateHooks[address(0)];

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
		require(!accountLayout.crossLiquidationDetails[quote.partyB].inProgress, "LibQuote: PartyB is in cross liquidation process");

		if (quote.quoteStatus == QuoteStatus.PENDING || quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
			quote.statusModifyTimestamp = block.timestamp;
			accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);

			// send trading Fee back to partyA
			uint256 fee = LibQuote.getOpenTradingFee(quote.id);
			accountLayout.allocatedBalances[quote.partyA] += fee;
			emit SharedEvents.BalanceChangePartyA(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);

			LibQuote.removeFromPartyAPendingQuotes(quote);
			if (quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
				LibAccount.subFromPartyBPendingLockedBalances(quote);
				LibQuote.removeFromPartyBPendingQuotes(quote);
			}

			if (quote.quoteStatus == QuoteStatus.LOCKED) quoteLayout.partyALockQuotesCount[quote.partyA]--;

			quote.quoteStatus = QuoteStatus.EXPIRED;
			result = QuoteStatus.EXPIRED;

			address affiliateHook = accountLayout.affiliateHooks[quote.affiliate];
			address systemHook = accountLayout.affiliateHooks[address(0)];

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
