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
			require(
				sig_highest >= requestedClosePrice + (requestedClosePrice * forceCloseGapRatio) / 1e18,
				"PartyAFacet: Requested close price not reached"
			);
			closePrice = requestedClosePrice + (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sig_averagePrice ? closePrice : sig_averagePrice;
		} else {
			require(
				sig_lowest <= requestedClosePrice - (requestedClosePrice * forceCloseGapRatio) / 1e18,
				"PartyAFacet: Requested close price not reached"
			);
			closePrice = requestedClosePrice - (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sig_averagePrice ? sig_averagePrice : closePrice;
		}

		if (closePrice == sig_averagePrice) {
			require(sig_endTime - sig_startTime >= forceCloseMinSigPeriod, "PartyAFacet: Invalid signature period");
		}

		return closePrice;
	}

	function forceCloseUsingAllocatedBalances(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice, bool isSolvent) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		require(quote.quoteStatus == QuoteStatus.CLOSE_PENDING, "PartyAFacet: Invalid state");
		require(sig.endTime + maLayout.forceCloseSecondCooldown <= quote.deadline, "PartyBFacet: Close request is expired");
		require(quote.orderType == OrderType.LIMIT, "PartyBFacet: Quote's order type should be LIMIT");
		require(sig.startTime >= quote.statusModifyTimestamp + maLayout.forceCloseFirstCooldown, "PartyAFacet: Cooldown not reached");
		require(sig.endTime <= block.timestamp - maLayout.forceCloseSecondCooldown, "PartyAFacet: Cooldown not reached");
		require(sig.averagePrice <= sig.highest && sig.averagePrice >= sig.lowest, "PartyAFacet: Invalid average price");

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

		require(partyAAvailableBalance >= 0, "PartyAFacet: PartyA will be insolvent");

		// step 1 & 2 --> to solve using allocated balance or master account balance
		isSolvent = solveUsingAllocatedBalances(quoteId, closePrice, partyBAvailableBalance);
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

	function solveUsingAllocatedBalances(uint256 quoteId, uint256 closePrice, int256 partyBAvailableBalance) internal returns (bool solved) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		uint256 reservedBalance;
		solved = false;
		if (accountLayout.masterAccountMode[quote.partyB]) {
			reservedBalance = accountLayout.partyBAllocatedBalances[quote.partyB][address(0)];
		} else {
			reservedBalance = accountLayout.reserveVault[quote.partyB];
		}

		if (partyBAvailableBalance >= 0) {
			LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
			solved = true;
		} else if (partyBAvailableBalance + int256(reservedBalance) >= 0) {
			uint256 available = uint256(-partyBAvailableBalance);

			if (accountLayout.masterAccountMode[quote.partyB]) {
				accountLayout.partyBAllocatedBalances[quote.partyB][address(0)] -= available;
			} else {
				accountLayout.reserveVault[quote.partyB] -= available;
			}

			accountLayout.partyBAllocatedBalances[quote.partyB][quote.partyA] += available;
			emit SharedEvents.BalanceChangePartyB(quote.partyB, quote.partyA, available, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);

			LibQuote.closeQuote(quote, quote.quantityToClose, closePrice);
			solved = true;
		}
	}
}
