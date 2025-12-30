// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MAStorage } from "../storages/MAStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, PositionType, OrderType, QuoteStatus } from "../storages/QuoteStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { HighLowPriceSig } from "../storages/MuonStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibQuoteClose } from "./LibQuoteClose.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibSolvency } from "./LibSolvency.sol";
import { LibMuonForceActions } from "./muon/LibMuonForceActions.sol";
import { LibLiquidation } from "./LibLiquidation.sol";

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
			require(
				sig.highest >= requestedClosePrice + (requestedClosePrice * forceCloseGapRatio) / 1e18,
				"PartyAFacet: Requested close price not reached"
			);
			closePrice = requestedClosePrice + (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sigAveragePrice ? closePrice : sigAveragePrice;
		} else {
			require(
				sig.lowest <= requestedClosePrice - (requestedClosePrice * forceCloseGapRatio) / 1e18,
				"PartyAFacet: Requested close price not reached"
			);
			closePrice = requestedClosePrice - (requestedClosePrice * forceClosePricePenalty) / 1e18;
			closePrice = closePrice > sigAveragePrice ? sigAveragePrice : closePrice;
		}

		if (closePrice == sigAveragePrice)
			require(sig.endTime - sig.startTime >= maLayout.forceCloseMinSigPeriod, "PartyAFacet: Invalid signature period");

		return closePrice;
	}

	function liquidatePartyB(
		uint256 quoteId,
		uint256 closePrice,
		uint256 reservedBalance,
		int256 sigUpnlPartyB,
		uint256 sigCurrentPrice
	) internal returns (int256 upnlPartyB) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		address partyA = quote.partyA;
		address partyB = quote.partyB;

		accountLayout.reserveVault[quote.partyB] = 0;
		accountLayout.partyBAllocatedBalances[partyB][partyA] += reservedBalance;
		emit SharedEvents.BalanceChangePartyB(partyB, partyA, reservedBalance, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);

		// diff = PnL increment for partyB from moving currentPrice -> closePrice
		int256 diff = (int256(quote.quantityToClose) * (int256(closePrice) - int256(sigCurrentPrice))) / 1e18;
		if (quote.positionType == PositionType.LONG) {
			diff = diff * -1;
		}
		upnlPartyB = sigUpnlPartyB + diff;
		LibLiquidation.liquidatePartyB(partyB, partyA, upnlPartyB, block.timestamp);
	}

	function validateForceCloseConditions(uint256 quoteId, HighLowPriceSig memory highLowPrice) internal view {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		LibMuonForceActions.verifyHighLowPrice(highLowPrice, quote.partyB, quote.partyA, quote.symbolId);

		require(quote.quoteStatus == QuoteStatus.CLOSE_PENDING, "PartyAFacet: Invalid state");

		require(highLowPrice.endTime + maLayout.forceCloseSecondCooldown <= quote.deadline, "PartyAFacet: Close request is expired");

		require(quote.orderType == OrderType.LIMIT, "PartyAFacet: Quote's order type should be LIMIT");

		require(highLowPrice.startTime >= quote.statusModifyTimestamp + maLayout.forceCloseFirstCooldown, "PartyAFacet: Cooldown not reached");

		require(highLowPrice.endTime <= block.timestamp - maLayout.forceCloseSecondCooldown, "PartyAFacet: Cooldown not reached");

		require(
			highLowPrice.averagePrice <= highLowPrice.highest && highLowPrice.averagePrice >= highLowPrice.lowest,
			"PartyAFacet: Invalid average price"
		);
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

	function closeQuote(uint256 quoteId, uint256 closePrice, int256 partyBAvailableBalance, uint256 reservedBalance) internal returns (bool succeed) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		if (partyBAvailableBalance >= 0) {
			LibQuoteClose.closeQuote(quoteId, quote.quantityToClose, closePrice);
			return true;
		}

		address partyB = quote.partyB;
		address allocationKey = LibAccount.partyBAllocationKey(partyB, quote.partyA);

		if (partyBAvailableBalance + int256(reservedBalance) >= 0) {
			uint256 available = uint256(-partyBAvailableBalance);

			accountLayout.reserveVault[partyB] -= available;

			accountLayout.partyBAllocatedBalances[partyB][allocationKey] += available;
			emit SharedEvents.BalanceChangePartyB(partyB, quote.partyA, available, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);

			LibAccount.increasePartyBNonce(partyB, quote.partyA);

			LibQuoteClose.closeQuote(quoteId, quote.quantityToClose, closePrice);
			return true;
		}
	}

	/**
	 * @notice Closes a master-account quote using full uPNL if possible, otherwise a price-only fallback.
	 * @param quoteId The ID of the quote to close.
	 * @param currentPrice The current market price used for solvency checks.
	 * @param upnlPartyB The PartyB uPNL used for the primary solvency path.
	 * @param closePrice The force-close price to apply.
	 */
	function closeQuoteMasterAccountWithRespectToUpnl(
		uint256 quoteId,
		uint256 currentPrice,
		int256 upnlPartyB,
		uint256 closePrice
	) internal returns (bool isSolvent, int256 partyBAvailableForClose) {
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Close using UPNL
		(partyBAvailableForClose, ) = getAvailableBalancesAfterClose(quoteId, currentPrice, 0, upnlPartyB, closePrice);
		if (partyBAvailableForClose >= 0) {
			LibQuoteClose.closeQuote(quoteId, quote.quantityToClose, closePrice);
			return (true, partyBAvailableForClose);
		}

		// Close ignoring UPNL
		(partyBAvailableForClose, ) = getAvailableBalancesAfterClose(quoteId, currentPrice, 0, 0, closePrice);
		require(partyBAvailableForClose >= 0, "ForceActionsFacet: Insufficient balance");
		LibQuoteClose.closeQuote(quoteId, quote.quantityToClose, closePrice);

		return (false, partyBAvailableForClose);
	}
}
