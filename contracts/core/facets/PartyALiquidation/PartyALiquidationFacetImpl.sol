// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonLiquidation } from "../../libraries/muon/LibMuonLiquidation.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValues, QuoteStatus, Quote, QuoteStorage } from "../../storages/QuoteStorage.sol";
import { LiquidationSig, MuonStorage } from "../../storages/MuonStorage.sol";
import { LiquidationType, LiquidationDetail, LiquidationSettlementState, Price, AccountStorage } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { AffiliateStorage } from "../../storages/AffiliateStorage.sol";
import { ISymmioHook } from "../../interfaces/ISymmioHook.sol";
import { LibHook } from "../../libraries/LibHook.sol";

library PartyALiquidationFacetImpl {
	using LockedValuesOps for LockedValues;

	function liquidatePartyA(address partyA, LiquidationSig memory liquidationSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(QuoteStorage.layout().partyAPositionsCount[partyA] > 0, "LiquidationFacet: PartyA has no open positions");
		LibMuonLiquidation.verifyLiquidationSig(liquidationSig, partyA);
		require(block.timestamp <= liquidationSig.timestamp + MuonStorage.layout().upnlValidTime, "LiquidationFacet: Expired signature");
		int256 availableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			liquidationSig.upnl,
			accountLayout.allocatedBalances[partyA],
			partyA
		);
		require(availableBalance < 0, "LiquidationFacet: PartyA is solvent");
		maLayout.liquidationStatus[partyA] = true;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		accountLayout.liquidationDetails[partyA] = LiquidationDetail({
			liquidationId: liquidationSig.liquidationId,
			liquidationType: LiquidationType.NONE,
			upnl: liquidationSig.upnl,
			totalUnrealizedLoss: liquidationSig.totalUnrealizedLoss,
			deficit: 0,
			liquidationFee: 0,
			timestamp: liquidationSig.timestamp,
			involvedPartyBCounts: 0,
			partyAAccumulatedUpnl: 0,
			disputed: false,
			liquidationTimestamp: liquidationSig.timestamp
		});
		accountLayout.liquidators[partyA].push(msg.sender);
	}

	function setSymbolsPrice(address partyA, LiquidationSig memory liquidationSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		LibMuonLiquidation.verifyLiquidationSig(liquidationSig, partyA);
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		require(
			keccak256(accountLayout.liquidationDetails[partyA].liquidationId) == keccak256(liquidationSig.liquidationId),
			"LiquidationFacet: Invalid liquidationId"
		);
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		for (uint256 index = 0; index < liquidationSig.symbolIds.length; index++) {
			accountLayout.symbolsPrices[partyA][liquidationSig.symbolIds[index]] = Price(
				liquidationSig.prices[index],
				accountLayout.liquidationDetails[partyA].timestamp
			);
		}

		int256 availableBalance = LibAccount.partyAAvailableBalanceForLiquidation(
			liquidationSig.upnl,
			accountLayout.allocatedBalances[partyA],
			partyA
		);
		if (accountLayout.liquidationDetails[partyA].liquidationType == LiquidationType.NONE) {
			if (uint256(-availableBalance) < accountLayout.lockedBalances[partyA].lf) {
				uint256 remainingLf = accountLayout.lockedBalances[partyA].lf - uint256(-availableBalance);
				uint256 maxLf = maLayout.maxLiquidationProfitPerPosition * QuoteStorage.layout().partyAPositionsCount[partyA];
				if (remainingLf > maxLf) {
					accountLayout.balances[maLayout.liquidationInsuranceVault] += remainingLf - maxLf;
					remainingLf = maxLf;
				}
				accountLayout.liquidationDetails[partyA].liquidationType = LiquidationType.NORMAL;
				accountLayout.liquidationDetails[partyA].liquidationFee = remainingLf;
			} else if (uint256(-availableBalance) <= accountLayout.lockedBalances[partyA].lf + accountLayout.lockedBalances[partyA].cva) {
				uint256 deficit = uint256(-availableBalance) - accountLayout.lockedBalances[partyA].lf;
				accountLayout.liquidationDetails[partyA].liquidationType = LiquidationType.LATE;
				accountLayout.liquidationDetails[partyA].deficit = deficit;
			} else {
				uint256 deficit = uint256(-availableBalance) - accountLayout.lockedBalances[partyA].lf - accountLayout.lockedBalances[partyA].cva;
				accountLayout.liquidationDetails[partyA].liquidationType = LiquidationType.OVERDUE;
				accountLayout.liquidationDetails[partyA].deficit = deficit;
			}
			accountLayout.liquidators[partyA].push(msg.sender);
		}
	}

	function liquidatePendingPositionsPartyA(address partyA) internal returns (uint256[] memory liquidatedAmounts, bytes memory liquidationId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		liquidatedAmounts = new uint256[](quoteLayout.partyAPendingQuotes[partyA].length);
		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;
		for (uint256 index = 0; index < quoteLayout.partyAPendingQuotes[partyA].length; index++) {
			Quote storage quote = quoteLayout.quotes[quoteLayout.partyAPendingQuotes[partyA][index]];
			if (
				(quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) &&
				quoteLayout.partyBPendingQuotes[quote.partyB][partyA].length > 0
			) {
				delete quoteLayout.partyBPendingQuotes[quote.partyB][partyA];
				// Subtract from cross bucket before zeroing per-partyA balances
				accountLayout.partyBPendingLockedBalances[quote.partyB][address(0)].sub(
					accountLayout.partyBPendingLockedBalances[quote.partyB][partyA]
				);
				accountLayout.partyBPendingLockedBalances[quote.partyB][partyA].makeZero();
			}
			uint256 fee = LibQuote.getOpenTradingFee(quote.id);
			accountLayout.partyAReimbursement[partyA] += fee;
			emit SharedEvents.BalanceChangePartyA(partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);
			quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
			quote.statusModifyTimestamp = block.timestamp;
			liquidatedAmounts[index] = quote.quantity;
		}
		accountLayout.pendingLockedBalances[partyA].makeZero();
		delete quoteLayout.partyAPendingQuotes[partyA];
	}

	function liquidatePositionsPartyA(
		address partyA,
		uint256[] memory quoteIds
	)
		internal
		returns (
			bool,
			uint256[] memory liquidatedAmounts,
			uint256[] memory closeIds,
			uint256[] memory averageClosedPrices,
			bytes memory liquidationId
		)
	{
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		liquidatedAmounts = new uint256[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);
		averageClosedPrices = new uint256[](quoteIds.length);
		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;

		// Track unique partyBs for connection cleanup
		address[] memory partyBsToCheck = new address[](quoteIds.length);
		uint256 uniquePartyBs = 0;

		for (uint256 index = 0; index < quoteIds.length; index++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[index]];
			require(
				quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"LiquidationFacet: Invalid state"
			);
			require(!maLayout.partyBLiquidationStatus[quote.partyB][partyA], "LiquidationFacet: PartyB is in liquidation process");
			require(!ClearingHouseStorage.layout().crossLiquidationDetails[quote.partyB].inProgress, "LiquidationFacet: PartyB is in cross liquidation process");
			require(quote.partyA == partyA, "LiquidationFacet: Invalid party");
			require(
				accountLayout.symbolsPrices[partyA][quote.symbolId].timestamp == accountLayout.liquidationDetails[partyA].timestamp,
				"LiquidationFacet: Price should be set"
			);
			liquidatedAmounts[index] = quote.quantity - quote.closedAmount;
			closeIds[index] = quoteLayout.closeIds[quote.id];
			quote.quoteStatus = QuoteStatus.LIQUIDATED;
			quote.statusModifyTimestamp = block.timestamp;

			LibAccount.increasePartyBNonce(quote.partyB, partyA);

			(bool hasMadeProfit, uint256 amount) = LibQuote.getValueOfQuoteForPartyA(
				accountLayout.symbolsPrices[partyA][quote.symbolId].price,
				LibQuote.quoteOpenAmount(quote),
				quote
			);

			int256 accumulatedFundingFee = LibQuoteFunding.getAccumulatedFundingFee(quote.id);
			int256 pnlWithFunding = (hasMadeProfit ? int256(amount) : -int256(amount)) - accumulatedFundingFee;
			LiquidationSettlementState storage settlementState = accountLayout.settlementStates[partyA][quote.partyB];
			LiquidationDetail storage liquidationDetail = accountLayout.liquidationDetails[partyA];

			if (!settlementState.pending) {
				settlementState.pending = true;
				liquidationDetail.involvedPartyBCounts += 1;
			}
			if (liquidationDetail.liquidationType == LiquidationType.NORMAL) {
				settlementState.cva += quote.lockedValues.cva;

				settlementState.actualAmount += pnlWithFunding;
				settlementState.expectedAmount = settlementState.actualAmount;
			} else if (liquidationDetail.liquidationType == LiquidationType.LATE) {
				settlementState.cva +=
					quote.lockedValues.cva - ((quote.lockedValues.cva * liquidationDetail.deficit) / accountLayout.lockedBalances[partyA].cva);

				settlementState.actualAmount += pnlWithFunding;
				settlementState.expectedAmount = settlementState.actualAmount;
			} else if (liquidationDetail.liquidationType == LiquidationType.OVERDUE) {
				if (pnlWithFunding >= 0) {
					settlementState.actualAmount += pnlWithFunding;
					settlementState.expectedAmount += pnlWithFunding;
				} else {
					uint256 lossAmount = uint256(-pnlWithFunding);
					uint256 adjustedLoss = lossAmount - ((lossAmount * liquidationDetail.deficit) / uint256(-liquidationDetail.totalUnrealizedLoss));
					settlementState.actualAmount -= int256(adjustedLoss);
					settlementState.expectedAmount -= int256(lossAmount);
				}
			}
			LibAccount.subFromPartyBLockedBalances(quote);
			uint256 liquidationPrice = accountLayout.symbolsPrices[partyA][quote.symbolId].price;
			LibQuote.closePositionFully(quote.id, liquidationPrice);

			if (quoteLayout.partyBPositionsCount[quote.partyB][partyA] == 0) {
				int256 settleAmount = accountLayout.settlementStates[partyA][quote.partyB].expectedAmount;
				if (settleAmount < 0) {
					accountLayout.liquidationDetails[partyA].partyAAccumulatedUpnl += settleAmount;
				} else {
					if (accountLayout.partyBAllocatedBalances[quote.partyB][partyA] >= uint256(settleAmount)) {
						accountLayout.liquidationDetails[partyA].partyAAccumulatedUpnl += settleAmount;
					} else {
						accountLayout.liquidationDetails[partyA].partyAAccumulatedUpnl += int256(
							accountLayout.partyBAllocatedBalances[quote.partyB][partyA]
						);
					}
				}
			}

			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[index], liquidationPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[index], liquidationPrice, quote.partyA, quote.partyB)),
				quote.id
			);
			averageClosedPrices[index] = quote.avgClosedPrice;

			// Track unique partyBs
			bool found = false;
			for (uint256 j = 0; j < uniquePartyBs; j++) {
				if (partyBsToCheck[j] == quote.partyB) {
					found = true;
					break;
				}
			}
			if (!found) {
				partyBsToCheck[uniquePartyBs++] = quote.partyB;
			}

			emit SharedEvents.TradeVolumeRecorded(
				quote.id,
				(liquidatedAmounts[index] * liquidationPrice) / 1e18,
				quote.partyA,
				quote.partyB,
				quote.symbolId,
				quote.affiliate,
				SharedEvents.TradeVolumeType.LIQUIDATE
			);
		}
		for (uint256 i = 0; i < uniquePartyBs; i++) {
			LibConnections.removeConnectionIfNoPositions(partyA, partyBsToCheck[i]);
		}
		if (
			quoteLayout.partyAPositionsCount[partyA] == 0 &&
			accountLayout.liquidationDetails[partyA].partyAAccumulatedUpnl != accountLayout.liquidationDetails[partyA].upnl
		) {
			accountLayout.liquidationDetails[partyA].disputed = true;
			return (true, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
		}
		return (false, liquidatedAmounts, closeIds, averageClosedPrices, liquidationId);
	}

	function resolveLiquidationDispute(
		address partyA,
		address[] memory partyBs,
		int256[] memory amounts,
		bool disputed
	) internal returns (bytes memory) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		accountLayout.liquidationDetails[partyA].disputed = disputed;
		require(partyBs.length == amounts.length, "LiquidationFacet: Invalid length");
		for (uint256 i = 0; i < partyBs.length; i++) {
			accountLayout.settlementStates[partyA][partyBs[i]].actualAmount = amounts[i];
		}
		return accountLayout.liquidationDetails[partyA].liquidationId;
	}

	function settlePartyALiquidation(
		address partyA,
		address[] memory partyBs
	) internal returns (int256[] memory settleAmounts, bytes memory liquidationId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		require(!ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress, "LiquidationFacet: Takeover in progress");
		require(
			quoteLayout.partyAPositionsCount[partyA] == 0 && quoteLayout.partyAPendingQuotes[partyA].length == 0,
			"LiquidationFacet: PartyA has still open positions"
		);
		require(maLayout.liquidationStatus[partyA], "LiquidationFacet: PartyA is solvent");
		require(!accountLayout.liquidationDetails[partyA].disputed, "LiquidationFacet: PartyA liquidation process get disputed");
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = block.timestamp;
		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;
		settleAmounts = new int256[](partyBs.length);
		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];
			require(
				!ClearingHouseStorage.layout().crossLiquidationDetails[partyB].inProgress,
				"LiquidationFacet: PartyB is in cross liquidation"
			);
			require(accountLayout.settlementStates[partyA][partyB].pending, "LiquidationFacet: PartyB is not in settlement");
			accountLayout.settlementStates[partyA][partyB].pending = false;
			accountLayout.liquidationDetails[partyA].involvedPartyBCounts -= 1;

			int256 settleAmount = accountLayout.settlementStates[partyA][partyB].actualAmount;

			// Use correct allocation key based on cross mode
			address allocKey = LibAccount.partyBAllocationKey(partyB, partyA);

			accountLayout.partyBAllocatedBalances[partyB][allocKey] += accountLayout.settlementStates[partyA][partyB].cva;
			emit SharedEvents.BalanceChangePartyB(
				partyB,
				partyA,
				accountLayout.settlementStates[partyA][partyB].cva,
				SharedEvents.BalanceChangeType.CVA_IN
			);

			if (settleAmount < 0) {
				accountLayout.partyBAllocatedBalances[partyB][allocKey] += uint256(-settleAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(-settleAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
				settleAmounts[i] = settleAmount;
			} else {
				if (accountLayout.partyBAllocatedBalances[partyB][allocKey] >= uint256(settleAmount)) {
					accountLayout.partyBAllocatedBalances[partyB][allocKey] -= uint256(settleAmount);
					settleAmounts[i] = settleAmount;
					emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settleAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
				} else {
					settleAmounts[i] = int256(accountLayout.partyBAllocatedBalances[partyB][allocKey]);
					accountLayout.partyBAllocatedBalances[partyB][allocKey] = 0;
					emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settleAmounts[i]), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
				}
			}
			delete accountLayout.settlementStates[partyA][partyB];
		}
		if (accountLayout.liquidationDetails[partyA].involvedPartyBCounts == 0) {
			emit SharedEvents.BalanceChangePartyA(partyA, accountLayout.allocatedBalances[partyA], SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			uint256 reimbursement = accountLayout.partyAReimbursement[partyA];
			accountLayout.allocatedBalances[partyA] = reimbursement;
			accountLayout.partyAReimbursement[partyA] = 0;
			if (reimbursement > 0) {
				emit SharedEvents.BalanceChangePartyA(partyA, reimbursement, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			}
			accountLayout.lockedBalances[partyA].makeZero();

			uint256 lf = accountLayout.liquidationDetails[partyA].liquidationFee;
			if (lf > 0) {
				accountLayout.allocatedBalances[accountLayout.liquidators[partyA][0]] += lf / 2;
				accountLayout.allocatedBalances[accountLayout.liquidators[partyA][1]] += lf / 2;
				emit SharedEvents.BalanceChangePartyA(accountLayout.liquidators[partyA][0], lf / 2, SharedEvents.BalanceChangeType.LF_IN);
				emit SharedEvents.BalanceChangePartyA(accountLayout.liquidators[partyA][1], lf / 2, SharedEvents.BalanceChangeType.LF_IN);
			}
			delete accountLayout.liquidators[partyA];
			delete accountLayout.liquidationDetails[partyA].liquidationType;
			maLayout.liquidationStatus[partyA] = false;
			maLayout.partyALiquidatorLastActionTimestamp[partyA] = 0;
			LibAccount.increasePartyANonce(partyA);
		}
	}
}
