// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MAStorage } from "../storages/MAStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, PositionType, QuoteStatus } from "../storages/QuoteStorage.sol";
import { SettlementSig, QuoteSettlementData, UnifiedSettlementSig, UnifiedQuoteSettlementData } from "../storages/MuonStorage.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibAccount } from "./LibAccount.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibSigner } from "./LibSigner.sol";

library LibSettlement {
	function settleUpnl(
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices,
		address partyA,
		bool isForceClose
	) public returns (uint256[] memory newPartyBsAllocatedBalances) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(
			settleSig.quotesSettlementsData.length > 0 && settleSig.quotesSettlementsData.length == updatedPrices.length,
			"LibSettlement: Invalid length"
		);
		require(
			LibAccount.partyAAvailableBalanceForLiquidation(settleSig.upnlPartyA, accountLayout.allocatedBalances[partyA], partyA) >= 0,
			"LibSettlement: PartyA is insolvent"
		);

		address signer = LibSigner.getSigner();
		require(
			isForceClose || quoteLayout.partyBOpenPositions[signer][partyA].length > 0,
			"LibSettlement: Sender should have a position with partyA"
		);
		accountLayout.partyANonces[partyA] += 1;

		int256[] memory settleAmounts = new int256[](settleSig.upnlPartyBs.length);
		address[] memory partyBs = new address[](settleSig.upnlPartyBs.length);
		newPartyBsAllocatedBalances = new uint256[](settleSig.upnlPartyBs.length);

		for (uint256 i = 0; i < settleSig.quotesSettlementsData.length; i++) {
			QuoteSettlementData memory data = settleSig.quotesSettlementsData[i];
			Quote storage quote = quoteLayout.quotes[data.quoteId];
			uint256 oldOpenedPrice = quote.openedPrice;
			require(quote.partyA == partyA, "LibSettlement: PartyA is invalid");
			require(
				quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"LibSettlement: Invalid state"
			);
			require(data.partyBUpnlIndex <= settleSig.upnlPartyBs.length, "LibSettlement: Invalid partyBUpnlIndex in signature");
			require(
				partyBs[data.partyBUpnlIndex] == address(0) || partyBs[data.partyBUpnlIndex] == quote.partyB,
				"LibSettlement: Invalid upnlPartyBs list"
			);
			partyBs[data.partyBUpnlIndex] = quote.partyB;

			if (quote.openedPrice > data.currentPrice) {
				require(
					updatedPrices[i] < quote.openedPrice && updatedPrices[i] >= data.currentPrice,
					"LibSettlement: Updated price is out of range"
				);
			} else {
				require(
					updatedPrices[i] > quote.openedPrice && updatedPrices[i] <= data.currentPrice,
					"LibSettlement: Updated price is out of range"
				);
			}
			if (quote.positionType == PositionType.LONG) {
				settleAmounts[data.partyBUpnlIndex] +=
					((int256(updatedPrices[i]) - int256(quote.openedPrice)) * int256(LibQuote.quoteOpenAmount(quote))) / 1e18;
			} else {
				settleAmounts[data.partyBUpnlIndex] +=
					((int256(quote.openedPrice) - int256(updatedPrices[i])) * int256(LibQuote.quoteOpenAmount(quote))) / 1e18;
			}
			quote.openedPrice = updatedPrices[i];
			LibQuote.updatePartiesAggregatedPositionsNotional(quote, oldOpenedPrice);
		}

		int256 totalSettlementAmount;
		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];
			require(
				LibAccount.partyBAvailableBalanceForLiquidation(settleSig.upnlPartyBs[i], partyB, partyA) >= 0,
				"LibSettlement: PartyB should be solvent"
			);
			require(!MAStorage.layout().partyBLiquidationStatus[partyB][partyA], "LibSettlement: PartyB is in liquidation process");
			require(!accountLayout.crossLiquidationDetails[partyB].inProgress, "LibSettlement: PartyB is in cross liquidation process");

			if (!isForceClose && signer != partyB) {
				require(
					block.timestamp >= MAStorage.layout().lastUpnlSettlementTimestamp[signer][partyB][partyA] + MAStorage.layout().settlementCooldown,
					"LibSettlement: Cooldown should be passed"
				);
				MAStorage.layout().lastUpnlSettlementTimestamp[signer][partyB][partyA] = block.timestamp;
			}
			LibAccount.increasePartyBNonce(partyB, partyA);

			int256 settlementAmount = settleAmounts[i];

			totalSettlementAmount += settlementAmount;
			if (settlementAmount >= 0) {
				accountLayout.partyBAllocatedBalances[partyB][partyA] -= uint256(settlementAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			} else {
				if (AccountStorage.layout().masterAccountMode[partyB])
					accountLayout.partyBAllocatedBalances[partyB][address(0)] += uint256(-settlementAmount);
				else accountLayout.partyBAllocatedBalances[partyB][partyA] += uint256(-settlementAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(-settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			}
			newPartyBsAllocatedBalances[i] = accountLayout.partyBAllocatedBalances[partyB][partyA];
		}
		if (totalSettlementAmount >= 0) {
			accountLayout.allocatedBalances[partyA] += uint256(totalSettlementAmount);
			emit SharedEvents.BalanceChangePartyA(partyA, uint256(totalSettlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		} else {
			accountLayout.allocatedBalances[partyA] -= uint256(-totalSettlementAmount);
			emit SharedEvents.BalanceChangePartyA(partyA, uint256(-totalSettlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		}
	}

	/**
	 * @notice Unified settlement function that works for both masterAccount and normal partyB modes
	 * @dev Settles quotes for a single partyB across one or more partyAs
	 * @param sig The unified settlement signature containing quote data and UPNLs
	 * @param updatedPrices Array of new prices to set as openedPrice for each quote
	 * @param isForceClose Whether this is called in a force close context
	 * @return newPartyAsAllocatedBalances Array of new allocated balances for each partyA
	 */
	function settleUpnlUnified(
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices,
		bool isForceClose
	) public returns (uint256[] memory newPartyAsAllocatedBalances) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		address partyB = sig.partyB;
		bool isMasterAccountMode = accountLayout.masterAccountMode[partyB];

		// 1. Validate lengths
		require(sig.quotesSettlementsData.length > 0, "LibSettlement: Empty quotes array");
		require(sig.quotesSettlementsData.length == updatedPrices.length, "LibSettlement: Invalid prices length");
		require(sig.partyAs.length > 0, "LibSettlement: Empty partyAs array");
		require(sig.partyAs.length == sig.upnlPartyAs.length, "LibSettlement: Invalid upnlPartyAs length");

		// 2. Validate UPNL structure matches mode
		if (!isMasterAccountMode) {
			require(sig.upnlPartyBPerPartyA.length == sig.partyAs.length, "LibSettlement: Invalid upnlPartyBPerPartyA length");
		}

		// 3. Validate caller permissions
		address signer = LibSigner.getSigner();
		if (!isForceClose) {
			// Either caller is the partyB being settled OR caller has positions with at least one of the partyAs
			bool hasPosition = signer == partyB;
			if (!hasPosition) {
				for (uint256 i = 0; i < sig.partyAs.length; i++) {
					if (quoteLayout.partyBOpenPositions[signer][sig.partyAs[i]].length > 0) {
						hasPosition = true;
						break;
					}
				}
			}
			require(hasPosition, "LibSettlement: Sender should have a position with partyA");
		}

		// 4. Validate partyB not in cross liquidation
		require(!accountLayout.crossLiquidationDetails[partyB].inProgress, "LibSettlement: PartyB is in cross liquidation process");

		// 5. Validate partyB solvency based on mode
		if (isMasterAccountMode) {
			require(
				LibAccount.partyBAvailableBalanceForLiquidation(sig.upnlPartyB, partyB, address(0)) >= 0,
				"LibSettlement: PartyB is insolvent"
			);
		} else {
			for (uint256 i = 0; i < sig.partyAs.length; i++) {
				require(
					LibAccount.partyBAvailableBalanceForLiquidation(sig.upnlPartyBPerPartyA[i], partyB, sig.partyAs[i]) >= 0,
					"LibSettlement: PartyB is insolvent for partyA"
				);
			}
		}

		// 6. Validate all partyAs are solvent and not in liquidation, update nonces
		for (uint256 i = 0; i < sig.partyAs.length; i++) {
			address partyA = sig.partyAs[i];
			require(
				LibAccount.partyAAvailableBalanceForLiquidation(sig.upnlPartyAs[i], accountLayout.allocatedBalances[partyA], partyA) >= 0,
				"LibSettlement: PartyA is insolvent"
			);
			require(!maLayout.liquidationStatus[partyA], "LibSettlement: PartyA is in liquidation");
			require(!maLayout.partyBLiquidationStatus[partyB][partyA], "LibSettlement: PartyB is in liquidation with partyA");
		}

		// 7. Process quotes and calculate settlement amounts per partyA
		int256[] memory settleAmountsPerPartyA = new int256[](sig.partyAs.length);

		for (uint256 i = 0; i < sig.quotesSettlementsData.length; i++) {
			UnifiedQuoteSettlementData memory data = sig.quotesSettlementsData[i];
			Quote storage quote = quoteLayout.quotes[data.quoteId];
			uint256 oldOpenedPrice = quote.openedPrice;

			// Validate quote
			require(quote.partyB == partyB, "LibSettlement: Invalid partyB for quote");
			require(data.partyAIndex < sig.partyAs.length, "LibSettlement: Invalid partyAIndex");
			require(quote.partyA == sig.partyAs[data.partyAIndex], "LibSettlement: Invalid partyA for quote");
			require(
				quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"LibSettlement: Invalid quote state"
			);

			// Validate price range
			if (quote.openedPrice > data.currentPrice) {
				require(
					updatedPrices[i] < quote.openedPrice && updatedPrices[i] >= data.currentPrice,
					"LibSettlement: Updated price is out of range"
				);
			} else {
				require(
					updatedPrices[i] > quote.openedPrice && updatedPrices[i] <= data.currentPrice,
					"LibSettlement: Updated price is out of range"
				);
			}

			// Calculate settlement amount
			int256 amount;
			if (quote.positionType == PositionType.LONG) {
				amount = ((int256(updatedPrices[i]) - int256(quote.openedPrice)) * int256(LibQuote.quoteOpenAmount(quote))) / 1e18;
			} else {
				amount = ((int256(quote.openedPrice) - int256(updatedPrices[i])) * int256(LibQuote.quoteOpenAmount(quote))) / 1e18;
			}
			settleAmountsPerPartyA[data.partyAIndex] += amount;

			// Update quote
			quote.openedPrice = updatedPrices[i];
			LibQuote.updatePartiesAggregatedPositionsNotional(quote, oldOpenedPrice);
		}

		// 8. Apply settlements per partyA
		newPartyAsAllocatedBalances = new uint256[](sig.partyAs.length);

		for (uint256 i = 0; i < sig.partyAs.length; i++) {
			address partyA = sig.partyAs[i];
			int256 settlementAmount = settleAmountsPerPartyA[i];

			// Handle cooldown for non-forceClose, non-self settlement
			if (!isForceClose && signer != partyB) {
				require(
					block.timestamp >= maLayout.lastUpnlSettlementTimestamp[signer][partyB][partyA] + maLayout.settlementCooldown,
					"LibSettlement: Cooldown not passed"
				);
				maLayout.lastUpnlSettlementTimestamp[signer][partyB][partyA] = block.timestamp;
			}

			// Update partyA nonce
			accountLayout.partyANonces[partyA] += 1;

			// Update partyB nonce
			LibAccount.increasePartyBNonce(partyB, partyA);

			// Get allocation key based on mode
			address allocKey = isMasterAccountMode ? address(0) : partyA;

			// Update partyB balance
			if (settlementAmount >= 0) {
				// PartyB loses
				accountLayout.partyBAllocatedBalances[partyB][allocKey] -= uint256(settlementAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);

				// PartyA gains
				accountLayout.allocatedBalances[partyA] += uint256(settlementAmount);
				emit SharedEvents.BalanceChangePartyA(partyA, uint256(settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			} else {
				// PartyB gains
				accountLayout.partyBAllocatedBalances[partyB][allocKey] += uint256(-settlementAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(-settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);

				// PartyA loses
				accountLayout.allocatedBalances[partyA] -= uint256(-settlementAmount);
				emit SharedEvents.BalanceChangePartyA(partyA, uint256(-settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			}

			newPartyAsAllocatedBalances[i] = accountLayout.allocatedBalances[partyA];
		}
	}
}
