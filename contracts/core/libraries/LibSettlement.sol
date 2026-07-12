// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MAStorage } from "../storages/MAStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, PositionType } from "../storages/QuoteStorage.sol";
import { SettlementSig, QuoteSettlementData, UnifiedSettlementSig, UnifiedQuoteSettlementData } from "../storages/MuonStorage.sol";
import { LibQuote } from "./LibQuote.sol";
import { LibQuoteState } from "./extensions/LibQuoteState.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibPartyBState } from "./extensions/LibPartyBState.sol";
import { LibSymbolAdjustment } from "./LibSymbolAdjustment.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibSigner } from "./LibSigner.sol";

library LibSettlement {
	using LibPartyBState for address;
	using LibQuoteState for Quote;

	/// @notice Settles unrealized PnL by adjusting opened prices for quotes between Party A and multiple Party Bs.
	/// @return newPartyBsAllocatedBalances The updated allocated balances for each Party B after settlement.
	function settleUpnl(
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices,
		address partyA,
		bool privilegedMode
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
			privilegedMode || quoteLayout.partyBOpenPositions[signer][partyA].length > 0,
			"LibSettlement: Sender should have a position with partyA"
		);
		LibAccount.increasePartyANonce(partyA);

		int256[] memory settleAmounts = new int256[](settleSig.upnlPartyBs.length);
		address[] memory partyBs = new address[](settleSig.upnlPartyBs.length);
		newPartyBsAllocatedBalances = new uint256[](settleSig.upnlPartyBs.length);

		for (uint256 i = 0; i < settleSig.quotesSettlementsData.length; i++) {
			QuoteSettlementData memory data = settleSig.quotesSettlementsData[i];
			Quote storage quote = quoteLayout.quotes[data.quoteId];
			LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
			uint256 oldOpenedPrice = quote.openedPrice;
			require(quote.partyA == partyA, "LibSettlement: PartyA is invalid");
			quote.requireOpenPosition();
			require(data.partyBUpnlIndex <= settleSig.upnlPartyBs.length, "LibSettlement: Invalid partyBUpnlIndex in signature");
			require(
				partyBs[data.partyBUpnlIndex] == address(0) || partyBs[data.partyBUpnlIndex] == quote.partyB,
				"LibSettlement: Invalid upnlPartyBs list"
			);
			partyBs[data.partyBUpnlIndex] = quote.partyB;

			_validatePriceInRange(quote.openedPrice, data.currentPrice, updatedPrices[i]);
			settleAmounts[data.partyBUpnlIndex] += _calculateSettlementAmount(quote, updatedPrices[i]);
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
			partyB.requireNotLiquidating(partyA);

			if (!privilegedMode && signer != partyB) {
				require(
					block.timestamp >= MAStorage.layout().lastUpnlSettlementTimestamp[signer][partyB][partyA] + MAStorage.layout().settlementCooldown,
					"LibSettlement: Cooldown should be passed"
				);
				MAStorage.layout().lastUpnlSettlementTimestamp[signer][partyB][partyA] = block.timestamp;
			}
			LibAccount.increasePartyBNonce(partyB, partyA);

			int256 settlementAmount = settleAmounts[i];

			// Use correct allocation key based on cross mode
			address allocKey = LibAccount.partyBAllocationKey(partyB, partyA);

			totalSettlementAmount += settlementAmount;
			if (settlementAmount >= 0) {
				accountLayout.partyBAllocatedBalances[partyB][allocKey] -= uint256(settlementAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			} else {
				accountLayout.partyBAllocatedBalances[partyB][allocKey] += uint256(-settlementAmount);
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(-settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			}
			newPartyBsAllocatedBalances[i] = accountLayout.partyBAllocatedBalances[partyB][allocKey];
		}
		if (totalSettlementAmount >= 0) {
			accountLayout.allocatedBalances[partyA] += uint256(totalSettlementAmount);
			emit SharedEvents.BalanceChangePartyA(partyA, uint256(totalSettlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
		} else {
			accountLayout.allocatedBalances[partyA] -= uint256(-totalSettlementAmount);
			emit SharedEvents.BalanceChangePartyA(partyA, uint256(-totalSettlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
		}
	}

	/// @notice Unified settlement function that works for both crossPartyB and normal partyB modes
	/// @dev Settles quotes for a single partyB across one or more partyAs
	/// @param sig The unified settlement signature containing quote data and UPNLs
	/// @param updatedPrices Array of new prices to set as openedPrice for each quote
	/// @param privilegedMode When true, bypasses caller position checks and settlement cooldowns (used by force close and liquidation flows)
	/// @return newPartyAsAllocatedBalances Array of new allocated balances for each partyA
	/// @return settleAmountsPerPartyA Array of settlement amounts for each partyA (positive = partyA gains)
	function settleUpnlUnified(
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices,
		bool privilegedMode,
		bool applyPartyBLiquidationReserve
	) public returns (uint256[] memory newPartyAsAllocatedBalances, int256[] memory settleAmountsPerPartyA) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		address partyB = sig.partyB;
		bool isCrossPartyB = MAStorage.layout().crossModeEnabledForPartyB[partyB];

		// 1. Validate lengths
		require(sig.quotesSettlementsData.length > 0, "LibSettlement: Empty quotes array");
		require(sig.quotesSettlementsData.length == updatedPrices.length, "LibSettlement: Invalid prices length");
		require(sig.partyAs.length > 0, "LibSettlement: Empty partyAs array");
		require(sig.partyAs.length == sig.upnlPartyAs.length, "LibSettlement: Invalid upnlPartyAs length");

		// 2. Validate UPNL structure matches mode
		if (!isCrossPartyB) {
			require(sig.upnlPartyBPerPartyA.length == sig.partyAs.length, "LibSettlement: Invalid upnlPartyBPerPartyA length");
		}

		// 3. Validate caller permissions
		address signer = LibSigner.getSigner();
		if (!privilegedMode) {
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
		partyB.requireNotCrossLiquidating();

		// 5. Validate partyB solvency based on mode
		if (isCrossPartyB) {
			require(
				LibAccount.partyBAvailableBalanceForLiquidation(sig.upnlPartyB, partyB, address(0), applyPartyBLiquidationReserve) >= 0,
				"LibSettlement: PartyB is insolvent"
			);
		} else {
			for (uint256 i = 0; i < sig.partyAs.length; i++) {
				require(
					LibAccount.partyBAvailableBalanceForLiquidation(
						sig.upnlPartyBPerPartyA[i],
						partyB,
						sig.partyAs[i],
						applyPartyBLiquidationReserve
					) >= 0,
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
			partyB.requireNotLiquidatingAgainst(partyA);
		}

		// 7. Process quotes and calculate settlement amounts per partyA
		settleAmountsPerPartyA = new int256[](sig.partyAs.length);

		for (uint256 i = 0; i < sig.quotesSettlementsData.length; i++) {
			UnifiedQuoteSettlementData memory data = sig.quotesSettlementsData[i];
			Quote storage quote = quoteLayout.quotes[data.quoteId];
			LibSymbolAdjustment.requireNotFrozen(quote.symbolId);
			uint256 oldOpenedPrice = quote.openedPrice;

			// Validate quote
			require(quote.partyB == partyB, "LibSettlement: Invalid partyB for quote");
			require(data.partyAIndex < sig.partyAs.length, "LibSettlement: Invalid partyAIndex");
			require(quote.partyA == sig.partyAs[data.partyAIndex], "LibSettlement: Invalid partyA for quote");
			quote.requireOpenPosition();

			// Validate price range
			_validatePriceInRange(quote.openedPrice, data.currentPrice, updatedPrices[i]);

			// Calculate settlement amount
			settleAmountsPerPartyA[data.partyAIndex] += _calculateSettlementAmount(quote, updatedPrices[i]);

			// Update quote
			quote.openedPrice = updatedPrices[i];
			LibQuote.updatePartiesAggregatedPositionsNotional(quote, oldOpenedPrice);
		}

		// 8. Apply settlements per partyA
		newPartyAsAllocatedBalances = new uint256[](sig.partyAs.length);
		int256 partyBNetDelta;

		for (uint256 i = 0; i < sig.partyAs.length; i++) {
			address partyA = sig.partyAs[i];
			int256 settlementAmount = settleAmountsPerPartyA[i];

			// Handle cooldown for non-forceClose, non-self settlement
			if (!privilegedMode && signer != partyB) {
				require(
					block.timestamp >= maLayout.lastUpnlSettlementTimestamp[signer][partyB][partyA] + maLayout.settlementCooldown,
					"LibSettlement: Cooldown not passed"
				);
				maLayout.lastUpnlSettlementTimestamp[signer][partyB][partyA] = block.timestamp;
			}

			// Update nonces
			LibAccount.increaseBothNonces(partyB, partyA);

			// Emit partyB balance change events per partyA
			if (settlementAmount >= 0) {
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			} else {
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, uint256(-settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			}

			// For cross partyB, accumulate delta and apply once after loop to avoid intermediate underflow
			if (isCrossPartyB) {
				partyBNetDelta -= settlementAmount;
			} else {
				if (settlementAmount >= 0) {
					accountLayout.partyBAllocatedBalances[partyB][partyA] -= uint256(settlementAmount);
				} else {
					accountLayout.partyBAllocatedBalances[partyB][partyA] += uint256(-settlementAmount);
				}
			}

			// Update partyA balance
			if (settlementAmount >= 0) {
				accountLayout.allocatedBalances[partyA] += uint256(settlementAmount);
				emit SharedEvents.BalanceChangePartyA(partyA, uint256(settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			} else {
				accountLayout.allocatedBalances[partyA] -= uint256(-settlementAmount);
				emit SharedEvents.BalanceChangePartyA(partyA, uint256(-settlementAmount), SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			}

			newPartyAsAllocatedBalances[i] = accountLayout.allocatedBalances[partyA];
		}

		// Apply accumulated cross partyB balance delta once
		if (isCrossPartyB) {
			if (partyBNetDelta >= 0) {
				accountLayout.partyBAllocatedBalances[partyB][address(0)] += uint256(partyBNetDelta);
			} else {
				accountLayout.partyBAllocatedBalances[partyB][address(0)] -= uint256(-partyBNetDelta);
			}
		}
	}

	/// @notice Validates that the updated price falls strictly between the opened price (exclusive) and current price (inclusive).
	function _validatePriceInRange(uint256 openedPrice, uint256 currentPrice, uint256 updatedPrice) private pure {
		if (openedPrice > currentPrice) {
			require(updatedPrice < openedPrice && updatedPrice >= currentPrice, "LibSettlement: Updated price is out of range");
		} else {
			require(updatedPrice > openedPrice && updatedPrice <= currentPrice, "LibSettlement: Updated price is out of range");
		}
	}

	/// @notice Calculates the settlement amount based on the price difference and position type.
	/// @return The settlement amount (positive = PartyA gains, negative = PartyA loses).
	function _calculateSettlementAmount(Quote storage quote, uint256 updatedPrice) private view returns (int256) {
		int256 openAmount = int256(LibQuote.quoteOpenAmount(quote));
		if (quote.positionType == PositionType.LONG) {
			return ((int256(updatedPrice) - int256(quote.openedPrice)) * openAmount) / 1e18;
		} else {
			return ((int256(quote.openedPrice) - int256(updatedPrice)) * openAmount) / 1e18;
		}
	}
}
