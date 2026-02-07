// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { AffiliateStorage } from "../../storages/AffiliateStorage.sol";
import { ClearingHouseStorage, CrossLiquidationDetail, PartyATakeoverDetail } from "../../storages/ClearingHouseStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { LibMuonLiquidation } from "../../libraries/muon/LibMuonLiquidation.sol";
import { ISymmioHook } from "../../interfaces/ISymmioHook.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { LibHook } from "../../libraries/LibHook.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { CrossLiquidationSig } from "../../storages/MuonStorage.sol";

library ClearingHouseFacetImpl {
	using LockedValuesOps for LockedValues;

	/// @dev Special allocation key used to pull from partyAReimbursement in deallocateForClearingHouse
	address internal constant REIMBURSEMENT_KEY = address(1);

	enum LiquidationType {
		NONE,
		CROSS_PARTY_B,
		PARTY_A_TAKEOVER
	}

	/// @notice Returns the type of clearing house liquidation in progress for a subject
	function getLiquidationType(address subject) internal view returns (LiquidationType) {
		if (ClearingHouseStorage.layout().crossLiquidationDetails[subject].inProgress) {
			return LiquidationType.CROSS_PARTY_B;
		}
		if (ClearingHouseStorage.layout().partyATakeoverDetails[subject].inProgress) {
			return LiquidationType.PARTY_A_TAKEOVER;
		}
		return LiquidationType.NONE;
	}

	/// @notice Initiates clearing house liquidation for a cross-margin PartyB
	function liquidateCrossPartyB(address partyB, CrossLiquidationSig memory liquidationSig) internal {
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(maLayout.crossModeEnabledForPartyB[partyB], "ClearingHouseFacet: partyB is not using cross mode");
		LibMuonLiquidation.verifyCrossLiquidation(liquidationSig, partyB);

		require(
			LibAccount.partyBAvailableBalanceForLiquidation(liquidationSig.upnl, partyB, address(0)) < 0,
			"ClearingHouseFacet: partyB is solvent"
		);
		maLayout.partyBLiquidationTimestamp[partyB][address(0)] = liquidationSig.timestamp;
		chLayout.crossLiquidationDetails[partyB] = CrossLiquidationDetail({
			liquidationId: liquidationSig.liquidationId,
			upnl: liquidationSig.upnl,
			timestamp: liquidationSig.timestamp,
			deallocatedPool: 0,
			inProgress: true
		});
	}

	/// @notice Takes over a stuck PartyA liquidation
	function takeoverPartyALiquidation(address partyA) internal returns (bytes memory liquidationId) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();

		require(maLayout.liquidationStatus[partyA], "ClearingHouseFacet: PartyA is not being liquidated");
		require(!chLayout.partyATakeoverDetails[partyA].inProgress, "ClearingHouseFacet: Takeover already in progress");

		liquidationId = _executeTakeover(partyA);
	}

	/// @notice Deallocates funds from parties for clearing house liquidation
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover)
	/// @param parties The parties to pull funds from
	/// @param allocationKeys The allocation keys for each party
	/// @param amounts The amounts to pull from each party
	function deallocateForClearingHouse(
		address subject,
		address[] memory parties,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(parties.length == allocationKeys.length && parties.length == amounts.length, "ClearingHouseFacet: Invalid length");

		LiquidationType liqType = getLiquidationType(subject);
		require(liqType != LiquidationType.NONE, "ClearingHouseFacet: No active liquidation");

		uint256 totalDeallocated = 0;

		for (uint256 i = 0; i < parties.length; i++) {
			address party = parties[i];
			address allocationKey = allocationKeys[i];
			uint256 amount = amounts[i];

			if (amount == 0) continue;

			if (party == subject && liqType == LiquidationType.PARTY_A_TAKEOVER) {
				// Pulling from partyA's own balances
				if (allocationKey == address(0)) {
					// Pull from allocatedBalances
					require(accountLayout.allocatedBalances[party] >= amount, "ClearingHouseFacet: Insufficient allocated balance");
					accountLayout.allocatedBalances[party] -= amount;
					emit SharedEvents.BalanceChangePartyA(party, amount, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
				} else if (allocationKey == REIMBURSEMENT_KEY) {
					// Pull from partyAReimbursement (special key)
					require(accountLayout.partyAReimbursement[party] >= amount, "ClearingHouseFacet: Insufficient reimbursement");
					accountLayout.partyAReimbursement[party] -= amount;
				} else {
					revert("ClearingHouseFacet: Invalid allocation key for partyA");
				}
			} else {
				// Pulling from partyB's allocated balances
				require(accountLayout.partyBAllocatedBalances[party][allocationKey] >= amount, "ClearingHouseFacet: Insufficient allocated balance");
				accountLayout.partyBAllocatedBalances[party][allocationKey] -= amount;
				emit SharedEvents.BalanceChangePartyB(party, allocationKey, amount, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			}

			totalDeallocated += amount;
		}

		// Add to the appropriate pool
		if (liqType == LiquidationType.CROSS_PARTY_B) {
			ClearingHouseStorage.layout().crossLiquidationDetails[subject].deallocatedPool += totalDeallocated;
		} else {
			ClearingHouseStorage.layout().partyATakeoverDetails[subject].deallocatedPool += totalDeallocated;
		}
	}

	/// @notice Distributes funds to receivers during clearing house liquidation
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover)
	/// @param receivers The addresses to distribute to
	/// @param allocationKeys The allocation keys for each receiver (for partyB: address(0) for cross mode, partyA for isolated)
	/// @param amounts The amounts to distribute
	function distributeForClearingHouse(
		address subject,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(receivers.length == allocationKeys.length && receivers.length == amounts.length, "ClearingHouseFacet: Invalid length");

		LiquidationType liqType = getLiquidationType(subject);
		require(liqType != LiquidationType.NONE, "ClearingHouseFacet: No active liquidation");

		for (uint256 i = 0; i < receivers.length; i++) {
			uint256 amount = amounts[i];
			if (amount == 0) continue;

			// Deduct from the appropriate pool
			if (liqType == LiquidationType.CROSS_PARTY_B) {
				CrossLiquidationDetail storage detail = ClearingHouseStorage.layout().crossLiquidationDetails[subject];
				require(detail.deallocatedPool >= amount, "ClearingHouseFacet: Insufficient deallocated balance");
				detail.deallocatedPool -= amount;
			} else {
				PartyATakeoverDetail storage detail = ClearingHouseStorage.layout().partyATakeoverDetails[subject];
				require(detail.deallocatedPool >= amount, "ClearingHouseFacet: Insufficient deallocated balance");
				detail.deallocatedPool -= amount;
			}

			// Credit to the appropriate receiver bucket
			if (maLayout.partyBStatus[receivers[i]]) {
				// Receiver is a partyB - use their appropriate bucket (cross or isolated)
				accountLayout.partyBAllocatedBalances[receivers[i]][allocationKeys[i]] += amount;
				emit SharedEvents.BalanceChangePartyB(receivers[i], allocationKeys[i], amount, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
			} else {
				// Receiver is a partyA or other address
				if (maLayout.liquidationStatus[receivers[i]]) {
					// PartyA is being liquidated — route to reimbursement so funds survive settlement.
					// No BalanceChangePartyA event here: reimbursement is escrow, not usable balance.
					// The event will be emitted at settlement when reimbursement becomes allocatedBalances.
					accountLayout.partyAReimbursement[receivers[i]] += amount;
				} else {
					accountLayout.allocatedBalances[receivers[i]] += amount;
					emit SharedEvents.BalanceChangePartyA(receivers[i], amount, SharedEvents.BalanceChangeType.REALIZED_PNL_IN);
				}
			}
		}
	}

	function _callCancelQuoteHooksAndUpdateStatus(Quote storage quote, address partyA, address partyB) private {
		address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
		address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
		LibHook.safeCall(affiliateHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quote.id, partyA, partyB)), quote.id);
		LibHook.safeCall(systemHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quote.id, partyA, partyB)), quote.id);
		quote.quoteStatus = QuoteStatus.LIQUIDATED_PENDING;
		quote.statusModifyTimestamp = block.timestamp;
	}

	function _clearPartyBPendingQuotes(address partyB, address partyA) private {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (quoteLayout.partyBPendingQuotes[partyB][partyA].length > 0) {
			delete quoteLayout.partyBPendingQuotes[partyB][partyA];
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].sub(accountLayout.partyBPendingLockedBalances[partyB][partyA]);
			accountLayout.partyBPendingLockedBalances[partyB][partyA].makeZero();
		}
	}

	/// @notice Liquidates pending positions during clearing house liquidation
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover)
	/// @param counterparties For cross partyB: the partyAs to process. For partyA takeover: ignored (processes all pending)
	function liquidatePendingPositionsForClearingHouse(
		address subject,
		address[] memory counterparties
	) internal returns (uint256[] memory liquidatedAmounts) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		LiquidationType liqType = getLiquidationType(subject);
		require(liqType != LiquidationType.NONE, "ClearingHouseFacet: No active liquidation");

		if (liqType == LiquidationType.CROSS_PARTY_B) {
			// Cross PartyB liquidation - process quotes where partyB matches subject
			address partyB = subject;
			for (uint256 j = 0; j < counterparties.length; j++) {
				address partyA = counterparties[j];
				_autoTakeoverPartyALiquidation(partyA);
				uint256[] storage pendingQuotes = quoteLayout.partyAPendingQuotes[partyA];
				for (uint256 i = 0; i < pendingQuotes.length; ) {
					Quote storage quote = quoteLayout.quotes[pendingQuotes[i]];
					if (quote.partyB == partyB) {
						accountLayout.pendingLockedBalances[partyA].subQuote(quote);
						uint256 fee = LibQuote.getOpenTradingFee(quote.id);
						if (MAStorage.layout().liquidationStatus[partyA]) {
							accountLayout.partyAReimbursement[partyA] += fee;
						} else {
							accountLayout.allocatedBalances[partyA] += fee;
							emit SharedEvents.BalanceChangePartyA(partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);
						}
						_callCancelQuoteHooksAndUpdateStatus(quote, partyA, partyB);
						pendingQuotes[i] = pendingQuotes[pendingQuotes.length - 1];
						pendingQuotes.pop();
					} else {
						i++;
					}
				}
				_clearPartyBPendingQuotes(partyB, partyA);
			}
			liquidatedAmounts = new uint256[](0); // Not tracked for cross partyB
		} else {
			// PartyA takeover - process all of partyA's pending quotes
			address partyA = subject;
			liquidatedAmounts = new uint256[](quoteLayout.partyAPendingQuotes[partyA].length);

			for (uint256 index = 0; index < quoteLayout.partyAPendingQuotes[partyA].length; index++) {
				Quote storage quote = quoteLayout.quotes[quoteLayout.partyAPendingQuotes[partyA][index]];
				if (quote.quoteStatus == QuoteStatus.LOCKED || quote.quoteStatus == QuoteStatus.CANCEL_PENDING) {
					_clearPartyBPendingQuotes(quote.partyB, partyA);
				}
				uint256 fee = LibQuote.getOpenTradingFee(quote.id);
				accountLayout.partyAReimbursement[partyA] += fee;
				// No BalanceChangePartyA event: reimbursement is escrow during takeover.
				// settlePartyATakeover handles final fund distribution.
				_callCancelQuoteHooksAndUpdateStatus(quote, partyA, quote.partyB);
				liquidatedAmounts[index] = quote.quantity;
			}
			accountLayout.pendingLockedBalances[partyA].makeZero();
			delete quoteLayout.partyAPendingQuotes[partyA];
		}
	}

	/// @notice Liquidates open positions during clearing house liquidation
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover)
	/// @param quoteIds The quote IDs to liquidate
	/// @param prices The prices to use for liquidation
	function liquidatePositionsForClearingHouse(
		address subject,
		uint256[] memory quoteIds,
		uint256[] memory prices
	) internal returns (uint256[] memory liquidatedAmounts, uint256[] memory closeIds) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		require(quoteIds.length == prices.length, "ClearingHouseFacet: Invalid length");

		LiquidationType liqType = getLiquidationType(subject);
		require(liqType != LiquidationType.NONE, "ClearingHouseFacet: No active liquidation");

		liquidatedAmounts = new uint256[](quoteIds.length);
		closeIds = new uint256[](quoteIds.length);

		// Track unique counterparties for connection cleanup
		address[] memory counterpartiesToCheck = new address[](quoteIds.length);
		uint256 uniqueCounterparties = 0;

		for (uint256 i = 0; i < quoteIds.length; i++) {
			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
			address partyA = quote.partyA;
			address partyB = quote.partyB;

			require(
				quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"ClearingHouseFacet: Invalid state"
			);

			// Validate the quote belongs to the subject
			if (liqType == LiquidationType.CROSS_PARTY_B) {
				require(partyB == subject, "ClearingHouseFacet: Invalid party");
				_autoTakeoverPartyALiquidation(partyA);
			} else {
				require(partyA == subject, "ClearingHouseFacet: Invalid party");
				require(!maLayout.partyBLiquidationStatus[partyB][partyA], "ClearingHouseFacet: PartyB is in liquidation process");
				require(
					!ClearingHouseStorage.layout().crossLiquidationDetails[partyB].inProgress,
					"ClearingHouseFacet: PartyB is in cross liquidation process"
				);
			}

			uint256 openAmount = LibQuote.quoteOpenAmount(quote);
			liquidatedAmounts[i] = openAmount;
			closeIds[i] = quoteLayout.closeIds[quote.id];
			quote.quoteStatus = QuoteStatus.LIQUIDATED;
			quote.statusModifyTimestamp = block.timestamp;

			accountLayout.lockedBalances[partyA].subQuote(quote);
			LibAccount.subFromPartyBLockedBalances(quote);

			uint256 liquidationPrice = prices[i];
			quote.avgClosedPrice = (quote.avgClosedPrice * quote.closedAmount + openAmount * liquidationPrice) / (quote.closedAmount + openAmount);
			LibQuote.subFromPartiesAggregatedPositions(quote, openAmount);
			quote.closedAmount = quote.quantity;

			LibQuote.removeFromOpenPositions(quote.id);
			quoteLayout.partyAPositionsCount[partyA] -= 1;
			quoteLayout.partyBPositionsCount[partyB][partyA] -= 1;
			quoteLayout.partyBPositionsCount[partyB][address(0)] -= 1; // total positions for partyB in cross partyB mode
			LibConnections.removeConnectionIfNoPositions(partyA, partyB);

			address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
			address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
			LibHook.safeCall(
				affiliateHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[i], liquidationPrice, partyA, partyB)),
				quote.id
			);
			LibHook.safeCall(
				systemHook,
				abi.encodeCall(ISymmioHook.onClosePosition, (quote.id, liquidatedAmounts[i], liquidationPrice, partyA, partyB)),
				quote.id
			);

			LibAccount.increasePartyBNonce(partyB, partyA);

			// Emit TradeVolumeRecorded for both liquidation types
			emit SharedEvents.TradeVolumeRecorded(
				quote.id,
				(liquidatedAmounts[i] * liquidationPrice) / 1e18,
				partyA,
				partyB,
				quote.symbolId,
				quote.affiliate,
				SharedEvents.TradeVolumeType.LIQUIDATE
			);

			// Track unique counterparties for connection cleanup
			// For PARTY_A_TAKEOVER: track partyBs. For CROSS_PARTY_B: track partyAs.
			address counterparty = (liqType == LiquidationType.PARTY_A_TAKEOVER) ? partyB : partyA;
			bool found = false;
			for (uint256 j = 0; j < uniqueCounterparties; j++) {
				if (counterpartiesToCheck[j] == counterparty) {
					found = true;
					break;
				}
			}
			if (!found) {
				counterpartiesToCheck[uniqueCounterparties++] = counterparty;
			}
		}

		// Connection cleanup: remove connections for counterparties with no more positions
		for (uint256 i = 0; i < uniqueCounterparties; i++) {
			if (liqType == LiquidationType.PARTY_A_TAKEOVER) {
				// subject=partyA, counterparty=partyB
				LibConnections.removeConnectionIfNoPositions(subject, counterpartiesToCheck[i]);
			} else {
				// subject=partyB, counterparty=partyA
				LibConnections.removeConnectionIfNoPositions(counterpartiesToCheck[i], subject);
			}
		}

		return (liquidatedAmounts, closeIds);
	}

	/// @notice Settles the clearing house liquidation for PartyA takeover
	/// @param partyA The partyA being settled
	/// @param settledPartyBs PartyBs whose settlement states should be cleaned up
	///        (includes partyBs processed by normal flow before takeover whose connections were already removed)
	function settlePartyATakeover(address partyA, address[] memory settledPartyBs) internal returns (bytes memory liquidationId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();

		require(chLayout.partyATakeoverDetails[partyA].inProgress, "ClearingHouseFacet: Takeover not in progress");
		require(
			quoteLayout.partyAPositionsCount[partyA] == 0 && quoteLayout.partyAPendingQuotes[partyA].length == 0,
			"ClearingHouseFacet: PartyA has still open positions"
		);
		require(chLayout.partyATakeoverDetails[partyA].deallocatedPool == 0, "ClearingHouseFacet: Undistributed funds in deallocated pool");

		liquidationId = chLayout.partyATakeoverDetails[partyA].liquidationId;

		// Clear settlement states for partyBs explicitly provided by the clearing house.
		// This is needed because the normal liquidation flow may have set settlement states
		// for partyBs whose connections were already removed from connectedPartyBs.
		for (uint256 i = 0; i < settledPartyBs.length; i++) {
			delete accountLayout.settlementStates[partyA][settledPartyBs[i]];
		}

		// Clear reimbursement
		accountLayout.partyAReimbursement[partyA] = 0;

		// Clear locked balances
		accountLayout.lockedBalances[partyA].makeZero();

		// Increment nonce
		accountLayout.partyANonces[partyA] += 1;

		// Clear liquidation status
		maLayout.liquidationStatus[partyA] = false;
		maLayout.partyALiquidatorLastActionTimestamp[partyA] = 0;

		// Delete liquidation details
		delete accountLayout.liquidationDetails[partyA];

		// Delete takeover details
		delete chLayout.partyATakeoverDetails[partyA];
	}

	/// @notice Settles the clearing house liquidation for a cross partyB
	/// @param partyB The cross partyB being settled
	function settleCrossPartyBLiquidation(address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();
		CrossLiquidationDetail storage detail = chLayout.crossLiquidationDetails[partyB];

		require(detail.inProgress, "ClearingHouseFacet: Cross liquidation not in progress");
		require(quoteLayout.partyBPositionsCount[partyB][address(0)] == 0, "ClearingHouseFacet: PartyB has still open positions");
		// NOTE: Using partyBPendingLockedBalances as a proxy for pending quotes; it can be zero even with pending quotes in edge cases.
		require(
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].totalForPartyB() == 0,
			"ClearingHouseFacet: PartyB has pending quotes"
		);
		require(detail.deallocatedPool == 0, "ClearingHouseFacet: Undistributed funds in deallocated pool");

		detail.inProgress = false;
		detail.timestamp = 0;
	}

	event AutoTakeoverPartyALiquidation(address indexed partyA, bytes liquidationId);

	/// @dev Shared takeover logic: clears disputed flag, liquidation fee, liquidators, and sets takeover state.
	function _executeTakeover(address partyA) private returns (bytes memory liquidationId) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();

		liquidationId = accountLayout.liquidationDetails[partyA].liquidationId;

		accountLayout.liquidationDetails[partyA].disputed = false;
		accountLayout.liquidationDetails[partyA].liquidationFee = 0;
		delete accountLayout.liquidators[partyA];

		chLayout.partyATakeoverDetails[partyA] = PartyATakeoverDetail({ liquidationId: liquidationId, deallocatedPool: 0, inProgress: true });
	}

	/// @dev Automatically takes over a partyA liquidation during cross partyB processing.
	///      Safe to call multiple times; only the first call has effect.
	function _autoTakeoverPartyALiquidation(address partyA) private returns (bool) {
		if (!MAStorage.layout().liquidationStatus[partyA]) return false;
		if (ClearingHouseStorage.layout().partyATakeoverDetails[partyA].inProgress) return false;

		bytes memory liquidationId = _executeTakeover(partyA);
		emit AutoTakeoverPartyALiquidation(partyA, liquidationId);
		return true;
	}

	function softPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();

		uint256 totalPenalty = penaltyFromAllocated + penaltyFromBalance;
		if (totalPenalty != 0) {
			require(globalLayout.softLiquidationPenaltyCollector != address(0), "ClearingHouse: No Penalty Collector");

			if (penaltyFromAllocated != 0) {
				require(
					penaltyFromAllocated <= accountLayout.partyBAllocatedBalances[partyB][partyA],
					"ClearingHouse: Insufficient Allocated Balance"
				);
				accountLayout.partyBAllocatedBalances[partyB][partyA] -= penaltyFromAllocated;
				emit SharedEvents.BalanceChangePartyB(partyB, partyA, penaltyFromAllocated, SharedEvents.BalanceChangeType.REALIZED_PNL_OUT);
			}

			if (penaltyFromBalance != 0) {
				require(penaltyFromBalance <= accountLayout.balances[partyB], "ClearingHouse: Insufficient Balance");
				accountLayout.balances[partyB] -= penaltyFromBalance;
			}

			accountLayout.balances[globalLayout.softLiquidationPenaltyCollector] += totalPenalty;
		}
	}
}
