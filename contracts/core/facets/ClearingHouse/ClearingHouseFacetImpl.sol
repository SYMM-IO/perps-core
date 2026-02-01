// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { AffiliateStorage } from "../../storages/AffiliateStorage.sol";
import { CrossPartyBStorage, CrossLiquidationDetail } from "../../storages/CrossPartyBStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibMuonLiquidation } from "../../libraries/muon/LibMuonLiquidation.sol";
import { ISymmioHook } from "../../interfaces/ISymmioHook.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibHook } from "../../libraries/LibHook.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { CrossLiquidationSig, QuotePriceSig } from "../../storages/MuonStorage.sol";

library ClearingHouseFacetImpl {
	using LockedValuesOps for LockedValues;

	function liquidateCrossPartyB(address partyB, CrossLiquidationSig memory liquidationSig) internal {
		CrossPartyBStorage.Layout storage crossLayout = CrossPartyBStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(crossLayout.crossModeEnabledForPartyB[partyB], "ClearingHouseFacet: partyB is not using cross mode");
		LibMuonLiquidation.verifyCrossLiquidation(liquidationSig, partyB);

		require(
			LibAccount.partyBAvailableBalanceForLiquidation(liquidationSig.upnl, partyB, address(0)) < 0,
			"ClearingHouseFacet: partyB is solvent"
		);
		maLayout.partyBLiquidationTimestamp[partyB][address(0)] = liquidationSig.timestamp;
		crossLayout.crossLiquidationDetails[partyB] = CrossLiquidationDetail({
			liquidationId: liquidationSig.liquidationId,
			upnl: liquidationSig.upnl,
			timestamp: liquidationSig.timestamp,
			deallocateForLiquidation: 0,
			inProgress: true
		});
	}

	function deallocateForCrossLiquidation(address partyB, address[] memory partyAs, uint256[] memory amounts) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		CrossPartyBStorage.Layout storage crossLayout = CrossPartyBStorage.layout();

		require(partyAs.length == amounts.length, "ClearingHouseFacet: Invalid length");
		CrossLiquidationDetail storage crossLiquidationDetail = crossLayout.crossLiquidationDetails[partyB];
		require(crossLiquidationDetail.inProgress == true, "ClearingHouseFacet: PartyB is solvent");
		for (uint256 i = 0; i < partyAs.length; i++) {
			address partyA = partyAs[i];
			uint256 amount = amounts[i];
			address allocationKey = LibAccount.partyBAllocationKey(partyB, partyA);
			require(accountLayout.partyBAllocatedBalances[partyB][allocationKey] >= amount, "ClearingHouseFacet: Insufficient allocated balance");
			accountLayout.partyBAllocatedBalances[partyB][allocationKey] -= amount;
			crossLiquidationDetail.deallocateForLiquidation += amount;
		}
	}

	function distributeForCrossLiquidation(address partyB, address[] memory receivers, uint256[] memory amounts) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		CrossPartyBStorage.Layout storage crossLayout = CrossPartyBStorage.layout();

		require(receivers.length == amounts.length, "ClearingHouseFacet: Invalid length");
		CrossLiquidationDetail storage crossLiquidationDetail = crossLayout.crossLiquidationDetails[partyB];
		require(crossLiquidationDetail.inProgress == true, "ClearingHouseFacet: PartyB is solvent");
		for (uint256 i = 0; i < receivers.length; i++) {
			require(crossLiquidationDetail.deallocateForLiquidation >= amounts[i], "ClearingHouseFacet: Insufficient allocated balance");
			crossLiquidationDetail.deallocateForLiquidation -= amounts[i];
			accountLayout.allocatedBalances[receivers[i]] += amounts[i];
		}
	}

	function liquidatePendingPositionsForCrossLiquidation(address partyB, address[] memory partyAs) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		CrossPartyBStorage.Layout storage crossLayout = CrossPartyBStorage.layout();

		CrossLiquidationDetail storage crossLiquidationDetail = crossLayout.crossLiquidationDetails[partyB];
		require(crossLiquidationDetail.inProgress == true, "ClearingHouseFacet: PartyB is solvent");

		for (uint256 j = 0; j < partyAs.length; j++) {
			address partyA = partyAs[j];
			uint256[] storage pendingQuotes = quoteLayout.partyAPendingQuotes[partyA];
			for (uint256 i = 0; i < pendingQuotes.length; ) {
				Quote storage quote = quoteLayout.quotes[pendingQuotes[i]];
				if (quote.partyB == partyB) {
					accountLayout.pendingLockedBalances[partyA].subQuote(quote);
					uint256 fee = LibQuote.getOpenTradingFee(quote.id);
					accountLayout.allocatedBalances[partyA] += fee;
					emit SharedEvents.BalanceChangePartyA(partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);
					pendingQuotes[i] = pendingQuotes[pendingQuotes.length - 1];
					pendingQuotes.pop();
					quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
					quote.statusModifyTimestamp = block.timestamp;
				} else {
					i++;
				}
			}

			if (quoteLayout.partyBPendingQuotes[partyB][partyA].length > 0) {
				delete quoteLayout.partyBPendingQuotes[partyB][partyA];
				accountLayout.partyBPendingLockedBalances[partyB][address(0)].sub(accountLayout.partyBPendingLockedBalances[partyB][partyA]);
				accountLayout.partyBPendingLockedBalances[partyB][partyA].makeZero();
			}
		}
	}

	function liquidatePositionsForCrossLiquidation(
		address partyB,
		QuotePriceSig memory priceSig
	) internal returns (uint256[] memory liquidatedAmounts, uint256[] memory closeIds) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		CrossPartyBStorage.Layout storage crossLayout = CrossPartyBStorage.layout();
		address partyA;

		LibMuonLiquidation.verifyQuotePrices(priceSig);

		CrossLiquidationDetail storage crossLiquidationDetail = crossLayout.crossLiquidationDetails[partyB];
		require(crossLiquidationDetail.inProgress == true, "ClearingHouseFacet: PartyB is solvent");

		require(
			priceSig.timestamp <= maLayout.partyBLiquidationTimestamp[partyB][address(0)] + maLayout.liquidationTimeout,
			"ClearingHouseFacet: Invalid signature"
		);
		require(maLayout.partyBLiquidationTimestamp[partyB][address(0)] <= priceSig.timestamp, "ClearingHouseFacet: Expired signature");

		liquidatedAmounts = new uint256[](priceSig.quoteIds.length);
		closeIds = new uint256[](priceSig.quoteIds.length);

		for (uint256 i = 0; i < priceSig.quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[priceSig.quoteIds[i]];
			partyA = quote.partyA;
			require(
				quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"ClearingHouseFacet: Invalid state"
			);
			require(quote.partyB == partyB, "ClearingHouseFacet: Invalid party");

			liquidatedAmounts[i] = quote.quantity - quote.closedAmount;
			closeIds[i] = quoteLayout.closeIds[quote.id];
			quote.quoteStatus = QuoteStatus.LIQUIDATED;
			quote.statusModifyTimestamp = block.timestamp;

			accountLayout.lockedBalances[partyA].subQuote(quote);
			LibAccount.subFromPartyBLockedBalances(quote);

			uint256 liquidationPrice = priceSig.prices[i];
			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			quote.avgClosedPrice = (quote.avgClosedPrice * quote.closedAmount + openAmount * liquidationPrice) / (quote.closedAmount + openAmount);
			LibQuote.subFromPartiesAggregatedPositions(quote, openAmount);
			quote.closedAmount = quote.quantity;

			LibQuote.removeFromOpenPositions(quote.id);
			quoteLayout.partyAPositionsCount[partyA] -= 1;
			quoteLayout.partyBPositionsCount[partyB][partyA] -= 1;
			quoteLayout.partyBPositionsCount[partyB][address(0)] -= 1; // total positions for partyB in cross partyB mode

			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[i], liquidationPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[i], liquidationPrice, partyA, quote.partyB)),
				quote.id
			);
			if (quoteLayout.partyBPositionsCount[partyB][partyA] == 0) {
				LibAccount.increasePartyBNonce(partyB, partyA);
			}
		}

		// If no more positions left for partyB in cross partyB mode, clear locked balances and cross liquidation status
		if (quoteLayout.partyBPositionsCount[partyB][address(0)] == 0) {
			crossLiquidationDetail.inProgress = false;
			crossLiquidationDetail.timestamp = 0;
		}

		return (liquidatedAmounts, closeIds);
	}

	function softPartyBLiquidation(address partyB, uint256 penalty) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		CrossPartyBStorage.Layout storage crossLayout = CrossPartyBStorage.layout();
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		require(crossLayout.crossModeEnabledForPartyB[partyB], "ClearingHouseFacet: partyB is not using cross mode");
		if (penalty != 0) {
			require(globalLayout.softLiquidationPenaltyCollector != address(0), "ClearingHouse: No Penalty Collector");
			require(penalty <= accountLayout.partyBAllocatedBalances[partyB][address(0)], "ClearingHouse: Insufficient Balance");
			accountLayout.partyBAllocatedBalances[partyB][address(0)] -= penalty;
			accountLayout.balances[globalLayout.softLiquidationPenaltyCollector] += penalty;
		}
	}
}
