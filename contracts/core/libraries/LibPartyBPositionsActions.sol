// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, PositionType, OrderType, QuoteStatus } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { AffiliateStorage } from "../storages/AffiliateStorage.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibQuoteClose } from "./LibQuoteClose.sol";
import { LibQuoteFunding } from "./LibQuoteFunding.sol";
import { LibAccount } from "./LibAccount.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { LibHook } from "./LibHook.sol";
import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

library LibPartyBPositionsActions {
	using LockedValuesOps for LockedValues;

	/// @notice Validates and fills a close request by checking state, expiry, price, and amount constraints.
	function fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice) internal {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
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
		LibQuoteClose.closeQuote(quote.id, filledAmount, closedPrice);
	}

	/// @notice Opens a position by filling a locked quote, handling partial fills and fee collection.
	function openPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice) internal returns (uint256 currentId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(SymbolStorage.layout().symbols[quote.symbolId].isValid, "PartyBFacet: Symbol is not valid");
		require(quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING, "PartyBFacet: Invalid state");
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");

		address feeCollector = LibAccount.getFeeCollector(quote.affiliate);
		if (quote.orderType == OrderType.LIMIT) {
			require(quote.quantity >= filledAmount && filledAmount > 0, "PartyBFacet: Invalid filledAmount");
			accountLayout.balances[feeCollector] += (filledAmount * quote.requestedOpenPrice * quote.tradingFee) / 1e36;
		} else {
			require(quote.quantity == filledAmount, "PartyBFacet: Invalid filledAmount");
			accountLayout.balances[feeCollector] += (filledAmount * quote.marketPrice * quote.tradingFee) / 1e36;
		}
		if (quote.positionType == PositionType.LONG) {
			require(openedPrice <= quote.requestedOpenPrice, "PartyBFacet: Opened price isn't valid");
		} else {
			require(openedPrice >= quote.requestedOpenPrice, "PartyBFacet: Opened price isn't valid");
		}

		quote.openedPrice = openedPrice;
		quote.initialOpenedPrice = openedPrice;
		quote.statusModifyTimestamp = block.timestamp;

		LibQuoteFunding.updateAccumulatedPaidFunding(quoteId);
		LibQuote.removeFromPendingQuotes(quote);
		quote.lastFundingPaymentTimestamp = block.timestamp;

		if (quote.quantity == filledAmount) {
			accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
			LibAccount.subFromPartyBPendingLockedBalances(quote);
			quote.lockedValues.mul(openedPrice).div(quote.requestedOpenPrice);

			// check locked values
			require(
				quote.lockedValues.totalForPartyA() >= SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Quote value is low"
			);
		}
		// partially fill
		else {
			currentId = ++quoteLayout.lastId;
			QuoteStatus newStatus;
			if (quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
				newStatus = QuoteStatus.CANCELED;
			} else {
				newStatus = QuoteStatus.PENDING;
				quoteLayout.partyAPendingQuotes[quote.partyA].push(currentId);
			}
			LockedValues memory filledLockedValues = LockedValues(
				(quote.lockedValues.cva * filledAmount) / quote.quantity,
				(quote.lockedValues.lf * filledAmount) / quote.quantity,
				(quote.lockedValues.partyAmm * filledAmount) / quote.quantity,
				(quote.lockedValues.partyBmm * filledAmount) / quote.quantity
			);
			LockedValues memory appliedFilledLockedValues = filledLockedValues;
			appliedFilledLockedValues = appliedFilledLockedValues.mulMem(openedPrice);
			appliedFilledLockedValues = appliedFilledLockedValues.divMem(quote.requestedOpenPrice);
			// check that opened position is not minor position
			require(
				appliedFilledLockedValues.totalForPartyA() >= SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Quote value is low"
			);
			// check that new pending position is not minor position
			require(
				newStatus == QuoteStatus.CANCELED ||
					(quote.lockedValues.totalForPartyA() - filledLockedValues.totalForPartyA()) >=
						SymbolStorage.layout().symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyBFacet: Quote value is low"
			);

			Quote memory q = Quote({
				id: currentId,
				partyBsWhiteList: quote.partyBsWhiteList,
				symbolId: quote.symbolId,
				positionType: quote.positionType,
				orderType: quote.orderType,
				openedPrice: 0,
				initialOpenedPrice: 0,
				requestedOpenPrice: quote.requestedOpenPrice,
				marketPrice: quote.marketPrice,
				quantity: quote.quantity - filledAmount,
				closedAmount: 0,
				lockedValues: LockedValues(0, 0, 0, 0),
				initialLockedValues: LockedValues(0, 0, 0, 0),
				maxFundingRate: quote.maxFundingRate,
				partyA: quote.partyA,
				partyB: address(0),
				quoteStatus: newStatus,
				avgClosedPrice: 0,
				requestedClosePrice: 0,
				parentId: quote.id,
				createTimestamp: quote.createTimestamp,
				statusModifyTimestamp: block.timestamp,
				quantityToClose: 0,
				lastFundingPaymentTimestamp: 0,
				deadline: quote.deadline,
				tradingFee: quote.tradingFee,
				affiliate: quote.affiliate,
				accumulatedPaidFunding: 0,
				closeFee: quote.closeFee,
				data: quote.data
			});

			quoteLayout.quoteIdsOf[quote.partyA].push(currentId);
			quoteLayout.quotes[currentId] = q;
			Quote storage newQuote = quoteLayout.quotes[currentId];

			if (newStatus == QuoteStatus.CANCELED) {
				// send trading Fee back to partyA
				LibAccount.refundOpenTradingFee(newQuote.id, newQuote.partyA);

				// part of quote has been filled and part of it has been canceled
				accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
			} else {
				accountLayout.pendingLockedBalances[quote.partyA].sub(filledLockedValues);
			}
			// update partyB pending locked balances
			LibAccount.subFromPartyBPendingLockedBalances(quote);

			newQuote.lockedValues = quote.lockedValues.sub(filledLockedValues);
			newQuote.initialLockedValues = newQuote.lockedValues;
			quote.quantity = filledAmount;
			quote.lockedValues = appliedFilledLockedValues;
		}
		// lock with amount of filledAmount
		accountLayout.lockedBalances[quote.partyA].addQuote(quote);
		LibAccount.addToPartyBLockedBalances(quote);

		// check leverage (is in 18 decimals)
		require(
			(quote.quantity * quote.openedPrice) / quote.lockedValues.totalForPartyA() <= SymbolStorage.layout().symbols[quote.symbolId].maxLeverage,
			"PartyBFacet: Leverage is high"
		);

		quoteLayout.partyBPositionsCount[quote.partyB][address(0)] += 1;
		quote.quoteStatus = QuoteStatus.OPENED;
		LibQuote.addToOpenPositions(quoteId);

		uint256 openFee = quote.orderType == OrderType.LIMIT
			? (filledAmount * quote.requestedOpenPrice * quote.tradingFee) / 1e36
			: (filledAmount * quote.marketPrice * quote.tradingFee) / 1e36;
		{
			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];

			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onOpenPosition, (quoteId, filledAmount, openedPrice, quote.partyA, quote.partyB)),
				quoteId
			);
			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(
					ISymmioHook.onFeeCharged,
					(quoteId, openFee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)
				),
				quoteId
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onOpenPosition, (quoteId, filledAmount, openedPrice, quote.partyA, quote.partyB)),
				quoteId
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(
					ISymmioHook.onFeeCharged,
					(quoteId, openFee, quote.partyA, quote.partyB, quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)
				),
				quoteId
			);
		}

		emit SharedEvents.TradeVolumeRecorded(
			quote.id,
			(filledAmount * quote.openedPrice) / 1e18,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradeVolumeType.OPEN
		);
		emit SharedEvents.TradingFeeCharged(
			quote.id,
			openFee,
			quote.partyA,
			quote.partyB,
			quote.symbolId,
			quote.affiliate,
			SharedEvents.TradingFeeType.OPEN
		);
	}
}
