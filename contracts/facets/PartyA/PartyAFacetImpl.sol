// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../libraries/muon/LibMuonPartyA.sol";
import "../../libraries/LibAccount.sol";
import "../../libraries/LibQuote.sol";
import "../../libraries/LibAccessibility.sol";
import "../../libraries/SharedEvents.sol";
import "../../storages/MAStorage.sol";
import "../../storages/QuoteStorage.sol";
import "../../storages/AccountStorage.sol";
import "../../storages/SymbolStorage.sol";

import "../../libraries/LibSigner.sol";

library PartyAFacetImpl {
	using LockedValuesOps for LockedValues;

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
		uint256 maxFundingRate,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig,
		bytes memory data
	) internal returns (uint256 currentId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		require(!LibAccessibility.hasRole(LibSigner.getSigner(), LibAccessibility.LIQUIDATOR_ROLE), "PartyAFacet: Liquidator can't be partyA");
		require(
			quoteLayout.partyAPendingQuotes[LibSigner.getSigner()].length < maLayout.pendingQuotesValidLength,
			"PartyAFacet: Number of pending quotes out of range"
		);
		require(symbolLayout.symbols[symbolId].isValid, "PartyAFacet: Symbol is not valid");
		require(deadline >= block.timestamp, "PartyAFacet: Low deadline");

		LockedValues memory lockedValues = LockedValues(cva, lf, partyAmm, partyBmm);
		uint256 tradingPrice = orderType == OrderType.LIMIT ? price : upnlSig.price;
		require(
			lockedValues.lf >= (symbolLayout.symbols[symbolId].minAcceptablePortionLF * lockedValues.totalForPartyA()) / 1e18,
			"PartyAFacet: LF is not enough"
		);

		require(lockedValues.totalForPartyA() >= symbolLayout.symbols[symbolId].minAcceptableQuoteValue, "PartyAFacet: Quote value is low");
		for (uint8 i = 0; i < partyBsWhiteList.length; i++) {
			require(partyBsWhiteList[i] != LibSigner.getSigner(), "PartyAFacet: Sender isn't allowed in partyBWhiteList");
		}

		address boundedPartyB = accountLayout.bindState[LibSigner.getSigner()].partyB;
		if (boundedPartyB != address(0)) {
			require(partyBsWhiteList.length == 1 && partyBsWhiteList[0] == boundedPartyB, "PartyAFacet: PartyA is bound to a different PartyB");
		} else {
			LibMuonPartyA.verifyPartyAUpnlAndPrice(upnlSig, LibSigner.getSigner(), symbolId);
		}

		Fee memory fee;
		if (appLayout.affiliateFee[affiliate][symbolId].isSet) {
			fee = appLayout.affiliateFee[affiliate][symbolId];
		} else {
			fee = appLayout.defaultAffiliateFee[affiliate];
			if (!fee.isSet) {
				uint256 symbolTradingFee = symbolLayout.symbols[symbolId].tradingFee;
				fee = Fee(symbolTradingFee, symbolTradingFee, true);
			}
		}

		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, LibSigner.getSigner());
		require(availableBalance > 0, "PartyAFacet: Available balance is lower than zero");
		require(
			uint256(availableBalance) >= lockedValues.totalForPartyA() + ((quantity * tradingPrice * fee.openFee) / 1e36),
			"PartyAFacet: insufficient available balance"
		);
		require(maLayout.affiliateStatus[affiliate] || affiliate == address(0), "PartyAFacet: Invalid affiliate");

		// lock funds the in middle of way
		accountLayout.pendingLockedBalances[LibSigner.getSigner()].add(lockedValues);
		currentId = ++quoteLayout.lastId;

		// create quote.
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
			maxFundingRate: maxFundingRate,
			partyA: LibSigner.getSigner(),
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
		quoteLayout.quoteIdsOf[LibSigner.getSigner()].push(currentId);
		quoteLayout.partyAPendingQuotes[LibSigner.getSigner()].push(currentId);
		quoteLayout.quotes[currentId] = quote;

		uint256 feeAmount = LibQuote.getOpenTradingFee(currentId);
		accountLayout.allocatedBalances[LibSigner.getSigner()] -= feeAmount;
		emit SharedEvents.BalanceChangePartyA(LibSigner.getSigner(), feeAmount, SharedEvents.BalanceChangeType.PLATFORM_FEE_OUT);
	}

	function requestToCancelQuote(uint256 quoteId) internal returns (QuoteStatus result) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.PENDING || quote.quoteStatus == QuoteStatus.LOCKED, "PartyAFacet: Invalid state");

		if (block.timestamp > quote.deadline) {
			result = LibQuote.expireQuote(quoteId);
		} else if (quote.quoteStatus == QuoteStatus.PENDING) {
			quote.quoteStatus = QuoteStatus.CANCELED;
			uint256 fee = LibQuote.getOpenTradingFee(quote.id);
			accountLayout.allocatedBalances[quote.partyA] += fee;
			emit SharedEvents.BalanceChangePartyA(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);
			accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
			LibQuote.removeFromPartyAPendingQuotes(quote);
			result = QuoteStatus.CANCELED;

			address affiliateHook = accountLayout.affiliateHooks[quote.affiliate];
			address systemHook = accountLayout.affiliateHooks[address(0)];

			if (affiliateHook != address(0)) {
				try ISymmioHook(affiliateHook).onCancelQuote(quoteId, quote.partyA, quote.partyB) {} catch {}
			}
			if (systemHook != address(0)) {
				try ISymmioHook(systemHook).onCancelQuote(quoteId, quote.partyA, quote.partyB) {} catch {}
			}
		} else {
			// Quote is locked
			quote.quoteStatus = QuoteStatus.CANCEL_PENDING;
			result = QuoteStatus.CANCEL_PENDING;
		}
		quote.statusModifyTimestamp = block.timestamp;
	}

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

	function requestToCancelCloseRequest(uint256 quoteId) internal returns (QuoteStatus) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.CLOSE_PENDING, "PartyAFacet: Invalid state");
		if (block.timestamp > quote.deadline) {
			LibQuote.expireQuote(quoteId);
			return QuoteStatus.OPENED;
		} else {
			quote.statusModifyTimestamp = block.timestamp;
			quote.quoteStatus = QuoteStatus.CANCEL_CLOSE_PENDING;
			return QuoteStatus.CANCEL_CLOSE_PENDING;
		}
	}
}
