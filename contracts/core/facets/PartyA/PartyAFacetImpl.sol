// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyA } from "../../libraries/muon/LibMuonPartyA.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues, PositionType, OrderType, SolverFeeCaps } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { AffiliateStorage } from "../../storages/AffiliateStorage.sol";
import { Fee } from "../../storages/QuoteStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { LibExecutionContext } from "../../libraries/LibExecutionContext.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { SingleUpnlAndPriceSig } from "../../storages/MuonStorage.sol";
import { ISymmioHook } from "../../interfaces/ISymmioHook.sol";
import { LibHook } from "../../libraries/LibHook.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library PartyAFacetImpl {
	using LockedValuesOps for LockedValues;

	/// @notice Validates inputs, locks collateral, and creates a new pending quote for Party A
	function sendQuote(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig,
		bytes memory data,
		SolverFeeCaps memory solverFeeCaps
	) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		AffiliateStorage.Layout storage affiliateLayout = AffiliateStorage.layout();
		address signer = LibSigner.getSigner();

		require(!LibAccessibility.hasRole(signer, LibAccessibility.LIQUIDATOR_ROLE), "PartyAFacet: Liquidator can't be partyA");
		require(
			quoteLayout.partyAPendingQuotes[signer].length < maLayout.pendingQuotesValidLength,
			"PartyAFacet: Number of pending quotes out of range"
		);
		require(symbolLayout.symbols[symbolId].isValid, "PartyAFacet: Symbol is not valid");
		LibSymbolAdjustment.requireNotFrozen(symbolId);
		require(deadline >= block.timestamp, "PartyAFacet: Low deadline");

		LockedValues memory lockedValues = LockedValues(cva, lf, partyAmm, partyBmm);
		require(
			lockedValues.lf >= (symbolLayout.symbols[symbolId].minAcceptablePortionLF * lockedValues.totalForPartyA()) / 1e18,
			"PartyAFacet: LF is not enough"
		);

		require(lockedValues.totalForPartyA() >= symbolLayout.symbols[symbolId].minAcceptableQuoteValue, "PartyAFacet: Quote value is low");
		for (uint8 i = 0; i < partyBsWhiteList.length; i++) {
			require(partyBsWhiteList[i] != signer, "PartyAFacet: Sender isn't allowed in partyBWhiteList");
		}

		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		address boundedPartyB = tradingLayout.bindState[signer].partyB;
		if (boundedPartyB != address(0)) {
			require(tradingLayout.isPartyBBindable[boundedPartyB], "PartyAFacet: Bound Party B is not Bindable");
			require(partyBsWhiteList.length == 1 && partyBsWhiteList[0] == boundedPartyB, "PartyAFacet: PartyA is bound to a different PartyB");
		} else {
			LibMuonPartyA.verifyPartyAUpnlAndPrice(upnlSig, signer, symbolId, MuonFunction.Trading);
		}

		require(maLayout.affiliateStatus[affiliate] || affiliate == address(0), "PartyAFacet: Invalid affiliate");
		require(
			affiliate == address(0) || GlobalAppStorage.layout().affiliateShutdownTime[affiliate] == 0,
			"PartyAFacet: Affiliate shutdown scheduled"
		);

		Fee memory fee;
		if (affiliateLayout.affiliateFeeForUser[affiliate][signer][symbolId].isSet) {
			fee = affiliateLayout.affiliateFeeForUser[affiliate][signer][symbolId];
		} else if (affiliateLayout.affiliateFeeForUser[affiliate][signer][0].isSet) {
			fee = affiliateLayout.affiliateFeeForUser[affiliate][signer][0];
		} else if (affiliateLayout.affiliateFee[affiliate][symbolId].isSet) {
			fee = affiliateLayout.affiliateFee[affiliate][symbolId];
		} else if (affiliateLayout.affiliateFee[affiliate][0].isSet) {
			fee = affiliateLayout.affiliateFee[affiliate][0];
		} else {
			uint256 symbolTradingFee = symbolLayout.symbols[symbolId].tradingFee;
			fee = Fee(symbolTradingFee, symbolTradingFee, true);
		}

		{
			int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, signer);
			require(availableBalance > 0, "PartyAFacet: Available balance is lower than zero");
			uint256 tradingPrice = orderType == OrderType.LIMIT ? price : upnlSig.price;
			require(
				uint256(availableBalance) >= lockedValues.totalForPartyA() + ((quantity * tradingPrice * fee.openFee) / 1e36),
				"PartyAFacet: insufficient available balance"
			);
		}
		// lock funds the in middle of way — skip in instantOpenMode (will be written directly to lockedBalances)
		bool _instantOpenMode = LibExecutionContext.isInstantOpenMode();
		if (!_instantOpenMode) {
			accountLayout.pendingLockedBalances[signer].add(lockedValues);
		}
		uint256 currentId = ++quoteLayout.lastId;

		// create quote.
		// NOTE: maxFundingRate is set to 1 (effectively disabled) because funding rate caps
		// for the accumulated funding system are postponed to a later version.
		// The field is kept for backward compatibility with existing quotes.
		Quote memory quote = Quote({
			id: currentId,
			partyBsWhiteList: partyBsWhiteList,
			symbolId: symbolId,
			positionType: positionType,
			orderType: orderType,
			openedPrice: 0,
			initialOpenedPrice: 0,
			requestedOpenPrice: price,
			marketPrice: upnlSig.price,
			quantity: quantity,
			closedAmount: 0,
			lockedValues: lockedValues,
			initialLockedValues: lockedValues,
			maxFundingRate: 1, // Funding caps postponed to a later version
			partyA: signer,
			partyB: address(0),
			quoteStatus: QuoteStatus.PENDING,
			avgClosedPrice: 0,
			requestedClosePrice: 0,
			parentId: 0,
			createTimestamp: block.timestamp,
			statusModifyTimestamp: block.timestamp,
			quantityToClose: 0,
			lastFundingPaymentTimestamp: 0,
			deadline: deadline,
			tradingFee: fee.openFee,
			affiliate: affiliate,
			accumulatedPaidFunding: 0,
			closeFee: fee.closeFee,
			data: data
		});
		quoteLayout.quoteIdsOf[signer].push(currentId);
		if (!_instantOpenMode) {
			quoteLayout.partyAPendingQuotes[signer].push(currentId);
		}
		quoteLayout.quotes[currentId] = quote;
		quoteLayout.solverFeeStates[currentId].openRateCap = solverFeeCaps.openRateCap;
		quoteLayout.solverFeeStates[currentId].closeRateCap = solverFeeCaps.closeRateCap;

		uint256 feeAmount = LibQuote.getReservedOpenTradingFee(quoteLayout.quotes[currentId], quantity);
		require(accountLayout.allocatedBalances[signer] >= feeAmount, "PartyAFacet: Insufficient allocated balance for fee");
		LibAccount.decreasePartyAAllocatedBalance(signer, feeAmount, SharedEvents.BalanceChangeType.PLATFORM_FEE_OUT);
		if (!_instantOpenMode) {
			LibAccount.reserveOpenTradingFee(signer, feeAmount);
		}
	}

	/// @notice Cancels a pending quote immediately or requests cancellation for a locked quote
	function requestToCancelQuote(uint256 quoteId) internal returns (QuoteStatus result) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.PENDING || quote.quoteStatus == QuoteStatus.LOCKED, "PartyAFacet: Invalid state");

		if (block.timestamp > quote.deadline) {
			result = LibQuoteClose.expireQuote(quoteId);
		} else if (quote.quoteStatus == QuoteStatus.PENDING) {
			quote.quoteStatus = QuoteStatus.CANCELED;
			LibAccount.refundOpenTradingFee(quote.id, quote.partyA);
			accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
			LibQuote.removeFromPartyAPendingQuotes(quote);
			result = QuoteStatus.CANCELED;

			LibHook.callCancelQuoteHooks(quoteId, quote.partyA, quote.partyB, quote.affiliate);
		} else {
			// Quote is locked
			quote.quoteStatus = QuoteStatus.CANCEL_PENDING;
			result = QuoteStatus.CANCEL_PENDING;
		}
		quote.statusModifyTimestamp = block.timestamp;
	}

	/// @notice Validates and sets a close request on an open position
	function requestToClosePosition(uint256 quoteId, uint256 closePrice, uint256 quantityToClose, OrderType orderType, uint256 deadline) internal {
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.OPENED, "PartyAFacet: Invalid state");
		require(deadline >= block.timestamp, "PartyAFacet: Low deadline");
		require(LibQuote.quoteOpenAmount(quote) >= quantityToClose, "PartyAFacet: Invalid quantityToClose");

		// check that remaining position is not too small
		if (LibQuote.quoteOpenAmount(quote) > quantityToClose) {
			require(
				((LibQuote.quoteOpenAmount(quote) - quantityToClose) * quote.lockedValues.totalForPartyA()) / LibQuote.quoteOpenAmount(quote) >=
					symbolLayout.symbols[quote.symbolId].minAcceptableQuoteValue,
				"PartyAFacet: Remaining quote value is low"
			);
		}
		quoteLayout.closeIds[quoteId] = ++quoteLayout.lastCloseId;
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.CLOSE_PENDING;
		quote.requestedClosePrice = closePrice;
		quote.quantityToClose = quantityToClose;
		quote.orderType = orderType;
		quote.deadline = deadline;
	}

	/// @notice Cancels a pending close request or expires it if past the deadline
	function requestToCancelCloseRequest(uint256 quoteId) internal returns (QuoteStatus) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.CLOSE_PENDING, "PartyAFacet: Invalid state");
		if (block.timestamp > quote.deadline) {
			LibQuoteClose.expireQuote(quoteId);
			return QuoteStatus.OPENED;
		} else {
			quote.statusModifyTimestamp = block.timestamp;
			quote.quoteStatus = QuoteStatus.CANCEL_CLOSE_PENDING;
			return QuoteStatus.CANCEL_CLOSE_PENDING;
		}
	}
}
