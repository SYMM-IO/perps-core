// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../storages/MAStorage.sol";
import "../storages/AccountStorage.sol";
import "./LibQuote.sol";
import "./LibAccount.sol";
import "./LibSolvency.sol";
import "./muon/LibMuonForceActions.sol";
import "./LibLiquidation.sol";

import "../facets/ForceActions/IForceActionsFacet.sol";

library LibForceSolve {
	function GetClosePrice(
		PositionType positionType,
		uint256 requestedClosePrice,
		uint256 forceCloseGapRatio,
		uint256 sig_lowest,
		uint256 sig_highest,
		uint256 sig_averagePrice,
		uint256 sig_startTime,
		uint256 sig_endTime,
		uint256 forceClosePricePenalty,
		uint256 forceCloseMinSigPeriod
	) internal pure returns (uint256 closePrice) {
		if (positionType == PositionType.LONG) {
			if (!(sig_highest >= requestedClosePrice + (requestedClosePrice * forceCloseGapRatio) / 1e18)) {
				revert PartyAFacetRequestedClosePriceNotReached();
			}
			closePrice = requestedClosePrice + (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sig_averagePrice ? closePrice : sig_averagePrice;
		} else {
			if (!(sig_lowest <= requestedClosePrice - (requestedClosePrice * forceCloseGapRatio) / 1e18)) {
				revert PartyAFacetRequestedClosePriceNotReached();
			}
			closePrice = requestedClosePrice - (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sig_averagePrice ? sig_averagePrice : closePrice;
		}

		if (closePrice == sig_averagePrice) {
			if (!(sig_endTime - sig_startTime >= forceCloseMinSigPeriod)) {
				revert PartyAFacetInvalidSignaturePeriod();
			}
		}

		return closePrice;
	}

	function forceCloseUsingAllocatedBalances(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice, bool isSolvent) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		if (quote.quoteStatus != QuoteStatus.CLOSE_PENDING) {
			revert PartyAFacetInvalidState();
		}

		if (!(sig.endTime + maLayout.forceCloseSecondCooldown <= quote.deadline)) {
			revert PartyBFacetCloseRequestExpired();
		}

		if (quote.orderType != OrderType.LIMIT) {
			revert PartyBFacetInvalidOrderType();
		}

		if (!(sig.startTime >= quote.statusModifyTimestamp + maLayout.forceCloseFirstCooldown)) {
			revert PartyAFacetCooldownNotReached();
		}

		if (!(sig.endTime <= block.timestamp - maLayout.forceCloseSecondCooldown)) {
			revert PartyAFacetCooldownNotReached();
		}

		if (!(sig.averagePrice <= sig.highest && sig.averagePrice >= sig.lowest)) {
			revert PartyAFacetInvalidAveragePrice();
		}

		accountLayout.partyANonces[quote.partyA] += 1;
		accountLayout.partyBNonces[quote.partyB][quote.partyA] += 1;

		LibMuonForceActions.verifyHighLowPrice(sig, quote.partyB, quote.partyA, quote.symbolId);

		closePrice = GetClosePrice(
			quote.positionType,
			quote.requestedClosePrice,
			symbolLayout.forceCloseGapRatio[quote.symbolId],
			sig.lowest,
			sig.highest,
			sig.averagePrice,
			sig.startTime,
			sig.endTime,
			maLayout.forceClosePricePenalty,
			maLayout.forceCloseMinSigPeriod
		);

		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = getAvailableBalancesAfterClose(
			quoteId,
			sig.currentPrice,
			sig.upnlPartyA,
			sig.upnlPartyB,
			closePrice
		);

		if (!(partyAAvailableBalance >= 0)) {
			revert PartyAFacetPartyAWillBeInsolvent();
		}

		uint256 reservedBalance;
		bool isMasterAccount = accountLayout.masterAccountMode[quote.partyB];
		if (isMasterAccount) {
			reservedBalance = accountLayout.partyBAllocatedBalances[quote.partyB][address(0)];
		} else {
			reservedBalance = accountLayout.reserveVault[quote.partyB];
		}
		isSolvent = solveUsingAllocatedBalances(quoteId, closePrice, partyBAvailableBalance, reservedBalance, isMasterAccount);
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

	function getAvailableBalancesAfterClose(
		uint256 quoteId,
		uint256 sig_currentPrice,
		int256 sig_upnlPartyA,
		int256 sig_upnlPartyB,
		uint256 closePrice
	) internal view returns (int256 partyBAvailableBalance, int256 partyAAvailableBalance) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		uint256[] memory quoteIds = new uint256[](1);
		uint256[] memory filledAmounts = new uint256[](1);
		uint256[] memory closedPrices = new uint256[](1);
		uint256[] memory marketPrices = new uint256[](1);

		quoteIds[0] = quoteId;
		filledAmounts[0] = quote.quantityToClose;
		closedPrices[0] = closePrice;
		marketPrices[0] = sig_currentPrice;

		(partyBAvailableBalance, partyAAvailableBalance) = LibSolvency.getAvailableBalanceAfterClosePosition(
			quoteIds,
			filledAmounts,
			closedPrices,
			marketPrices,
			sig_upnlPartyB,
			sig_upnlPartyA,
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

			LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
			solved = true;
		}
	}
}
