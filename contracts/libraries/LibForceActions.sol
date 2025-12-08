// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../storages/MAStorage.sol";
import "../storages/AccountStorage.sol";
import "../storages/QuoteStorage.sol";
import "./LibQuote.sol";
import "./LibAccount.sol";
import "./LibSolvency.sol";
import "./muon/LibMuonForceActions.sol";
import "./LibLiquidation.sol";

import "../facets/ForceActions/IForceActionsFacet.sol";

library LibForceActions {
	function verifyAndGetClosePrice(uint256 quoteId, HighLowPriceSig memory sig) internal view returns (uint256 closePrice) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote memory quote = QuoteStorage.layout().quotes[quoteId];
		PositionType positionType = quote.positionType;
		uint256 forceCloseGapRatio = SymbolStorage.layout().forceCloseGapRatio[quote.symbolId];
		uint256 forceClosePricePenalty = maLayout.forceClosePricePenalty;
		uint256 requestedClosePrice = quote.requestedClosePrice;
		uint256 sigAveragePrice = sig.averagePrice;

		if (positionType == PositionType.LONG) {
			if (!(sig.highest >= requestedClosePrice + (requestedClosePrice * forceCloseGapRatio) / 1e18)) {
				revert ForceCloseErrors.RequestedClosePriceNotReached();
			}
			closePrice = requestedClosePrice + (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sigAveragePrice ? closePrice : sigAveragePrice;
		} else {
			if (!(sig.lowest <= requestedClosePrice - (requestedClosePrice * forceCloseGapRatio) / 1e18)) {
				revert ForceCloseErrors.RequestedClosePriceNotReached();
			}
			closePrice = requestedClosePrice - (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sigAveragePrice ? sigAveragePrice : closePrice;
		}

		if (closePrice == sigAveragePrice) {
			if (!(sig.endTime - sig.startTime >= maLayout.forceCloseMinSigPeriod)) {
				revert ForceCloseErrors.InvalidSignaturePeriod();
			}
		}

		return closePrice;
	}

	function liquidatePartyB(
		uint256 quoteId,
		uint256 closePrice,
		uint256 reservedBalance,
		int256 sig_upnlPartyB,
		uint256 sig_currentPrice
	) internal returns (int256 upnlPartyB) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		address partyA = quote.partyA;
		address partyB = quote.partyB;

		accountLayout.reserveVault[quote.partyB] = 0;
		accountLayout.partyBAllocatedBalances[partyB][partyA] += reservedBalance;
		emit SharedEvents.BalanceChangePartyB(partyB, partyA, reservedBalance, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		int256 diff = (int256(quote.quantityToClose) * (int256(closePrice) - int256(sig_currentPrice))) / 1e18;
		if (quote.positionType == PositionType.LONG) {
			diff = diff * -1;
		}
		upnlPartyB = sig_upnlPartyB + diff;
		LibLiquidation.liquidatePartyB(partyB, partyA, upnlPartyB, block.timestamp);
	}

	function verifyPrice(uint256 quoteId, HighLowPriceSig memory highLowPrice) internal view {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		LibMuonForceActions.verifyHighLowPrice(highLowPrice, quote.partyB, quote.partyA, quote.symbolId);

		if (quote.quoteStatus != QuoteStatus.CLOSE_PENDING) {
			revert ForceCloseErrors.InvalidState();
		}

		if (!(highLowPrice.endTime + maLayout.forceCloseSecondCooldown <= quote.deadline)) {
			revert ForceCloseErrors.CloseRequestExpired();
		}

		if (quote.orderType != OrderType.LIMIT) {
			revert ForceCloseErrors.InvalidOrderType();
		}

		if (!(highLowPrice.startTime >= quote.statusModifyTimestamp + maLayout.forceCloseFirstCooldown)) {
			revert ForceCloseErrors.CooldownNotReached();
		}

		if (!(highLowPrice.endTime <= block.timestamp - maLayout.forceCloseSecondCooldown)) {
			revert ForceCloseErrors.CooldownNotReached();
		}

		if (!(highLowPrice.averagePrice <= highLowPrice.highest && highLowPrice.averagePrice >= highLowPrice.lowest)) {
			revert ForceCloseErrors.InvalidAveragePrice();
		}
	}

	function getAvailableBalancesAfterClose(
		uint256 quoteId,
		uint256 sigCurrentPrice,
		int256 sigUpnlPartyA,
		int256 sigUpnlPartyB,
		uint256 closePrice
	) internal view returns (int256 partyBAvailableBalance, int256 partyAAvailableBalance) {
		Quote memory quote = QuoteStorage.layout().quotes[quoteId];

		uint256[] memory quoteIds = new uint256[](1);
		uint256[] memory filledAmounts = new uint256[](1);
		uint256[] memory closedPrices = new uint256[](1);
		uint256[] memory marketPrices = new uint256[](1);

		quoteIds[0] = quoteId;
		filledAmounts[0] = quote.quantityToClose;
		closedPrices[0] = closePrice;
		marketPrices[0] = sigCurrentPrice;

		(partyBAvailableBalance, partyAAvailableBalance) = LibSolvency.getAvailableBalanceAfterClosePosition(
			quoteIds,
			filledAmounts,
			closedPrices,
			marketPrices,
			sigUpnlPartyB,
			sigUpnlPartyA,
			quote.partyB,
			quote.partyA
		);
	}

	function solveUsingAllocatedBalances(
		uint256 quoteId,
		uint256 closePrice,
		int256 partyBAvailableBalance,
		uint256 reservedBalance,
		bool isMasterAccount
	) internal returns (bool solved) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		address partyA = quote.partyA;
		address partyB = quote.partyB;

		if (partyBAvailableBalance >= 0) {
			LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
			solved = true;
		} else if (partyBAvailableBalance + int256(reservedBalance) >= 0) {
			uint256 available = uint256(-partyBAvailableBalance);

			if (isMasterAccount) {
				accountLayout.partyBAllocatedBalances[partyB][address(0)] -= available;
			} else {
				accountLayout.reserveVault[partyB] -= available;
			}

			accountLayout.partyBAllocatedBalances[partyB][partyA] += available;
			emit SharedEvents.BalanceChangePartyB(partyB, partyA, available, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);

			accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;

			LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
			solved = true;
		}
	}
}
