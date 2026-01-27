// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonLiquidation } from "../../libraries/muon/LibMuonLiquidation.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibLiquidation } from "../../libraries/LibLiquidation.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValues, QuoteStatus, Quote, QuoteStorage } from "../../storages/QuoteStorage.sol";
import { SingleUpnlSig, QuotePriceSig } from "../../storages/MuonStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { ISymmioHook } from "../../interfaces/ISymmioHook.sol";
import { LibHook } from "../../libraries/LibHook.sol";

library PartyBLiquidationFacetImpl {
	using LockedValuesOps for LockedValues;

	function liquidatePartyB(address partyB, address partyA, SingleUpnlSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(!accountLayout.masterAccountMode[partyB], "LiquidationFacet: PartyB masterAccount mode is active");

		LibMuonLiquidation.verifyPartyBUpnl(upnlSig, partyB, partyA);
		LibLiquidation.liquidatePartyB(partyB, partyA, upnlSig.upnl, upnlSig.timestamp);
	}

	function liquidatePositionsPartyB(
		address partyB,
		address partyA,
		QuotePriceSig memory priceSig
	) internal returns (uint256[] memory liquidatedAmounts, uint256[] memory closeIds, uint256[] memory averageClosedPrices) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		LibMuonLiquidation.verifyQuotePrices(priceSig);
		require(
			priceSig.timestamp <= maLayout.partyBLiquidationTimestamp[partyB][partyA] + maLayout.liquidationTimeout,
			"LiquidationFacet: Invalid signature"
		);
		require(maLayout.partyBLiquidationStatus[partyB][partyA], "LiquidationFacet: PartyB is solvent");
		require(maLayout.partyBLiquidationTimestamp[partyB][partyA] <= priceSig.timestamp, "LiquidationFacet: Expired signature");

		liquidatedAmounts = new uint256[](priceSig.quoteIds.length);
		closeIds = new uint256[](priceSig.quoteIds.length);
		averageClosedPrices = new uint256[](priceSig.quoteIds.length);

		for (uint256 i = 0; i < priceSig.quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[priceSig.quoteIds[i]];
			require(
				quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"LiquidationFacet: Invalid state"
			);
			require(quote.partyA == partyA && quote.partyB == partyB, "LiquidationFacet: Invalid party");

			liquidatedAmounts[i] = quote.quantity - quote.closedAmount;
			closeIds[i] = quoteLayout.closeIds[quote.id];
			quote.quoteStatus = QuoteStatus.LIQUIDATED;
			quote.statusModifyTimestamp = block.timestamp;

			accountLayout.lockedBalances[partyA].subQuote(quote);

			uint256 liquidationPrice = priceSig.prices[i];
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			quote.avgClosedPrice = (quote.avgClosedPrice * quote.closedAmount + openAmount * liquidationPrice) / (quote.closedAmount + openAmount);
			LibQuote.subFromPartiesAggregatedPositions(quote, openAmount);
			quote.closedAmount = quote.quantity;

			LibQuote.removeFromOpenPositions(quote.id);
			quoteLayout.partyAPositionsCount[partyA] -= 1;
			quoteLayout.partyBPositionsCount[partyB][partyA] -= 1;
			quoteLayout.partyBPositionsCount[partyB][address(0)] -= 1;

			address affiliateHook = accountLayout.affiliateHooks[quote.affiliate];
			address systemHook = accountLayout.affiliateHooks[address(0)];

			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[i], liquidationPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[i], liquidationPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			averageClosedPrices[i] = quote.avgClosedPrice;
		}
		if (maLayout.partyBPositionLiquidatorsShare[partyB][partyA] > 0) {
			uint256 lf = maLayout.partyBPositionLiquidatorsShare[partyB][partyA] * priceSig.quoteIds.length;
			accountLayout.allocatedBalances[msg.sender] += lf;
			emit SharedEvents.BalanceChangePartyA(msg.sender, lf, SharedEvents.BalanceChangeType.LF_IN);
		}

		if (quoteLayout.partyBPositionsCount[partyB][partyA] == 0) {
			maLayout.partyBLiquidationStatus[partyB][partyA] = false;
			maLayout.partyBLiquidationTimestamp[partyB][partyA] = 0;
			LibAccount.increasePartyBNonce(partyB, partyA);
		}
		return (liquidatedAmounts, closeIds, averageClosedPrices);
	}
}
