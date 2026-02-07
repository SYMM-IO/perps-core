// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../storages/AccountStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";
import { Quote, LockedValues } from "../storages/QuoteStorage.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibQuote } from "./LibQuote.sol";

library LibAccount {
	using LockedValuesOps for LockedValues;

	/**
	 * @notice Calculates the total locked balances of Party A.
	 * @param partyA The address of Party A.
	 * @return The total locked balances of Party A.
	 */
	function partyATotalLockedBalances(address partyA) internal view returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		return accountLayout.pendingLockedBalances[partyA].totalForPartyA() + accountLayout.lockedBalances[partyA].totalForPartyA();
	}

	/**
	 * @notice Calculates the total locked balances of Party B for a specific Party A.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @return The total locked balances of Party B for the specified Party A.
	 */
	function partyBTotalLockedBalances(address partyB, address partyA) internal view returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address allocationKey = partyBAllocationKey(partyB, partyA);
		return
			accountLayout.partyBPendingLockedBalances[partyB][allocationKey].totalForPartyB() +
			accountLayout.partyBLockedBalances[partyB][allocationKey].totalForPartyB();
	}

	/**
	 * @notice Calculates the available balance for a quote for Party A.
	 * @param upnl The unrealized profit and loss.
	 * @param partyA The address of Party A.
	 * @return The available balance for a quote for Party A.
	 */
	function partyAAvailableForQuote(int256 upnl, address partyA) internal view returns (int256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		int256 available;
		if (upnl >= 0) {
			available =
				int256(accountLayout.allocatedBalances[partyA]) +
				upnl -
				int256((accountLayout.lockedBalances[partyA].totalForPartyA() + accountLayout.pendingLockedBalances[partyA].totalForPartyA()));
		} else {
			int256 mm = int256(accountLayout.lockedBalances[partyA].partyAmm);
			int256 considering_mm = -upnl > mm ? -upnl : mm;
			available =
				int256(accountLayout.allocatedBalances[partyA]) -
				int256(
					(accountLayout.lockedBalances[partyA].cva +
						accountLayout.lockedBalances[partyA].lf +
						accountLayout.pendingLockedBalances[partyA].totalForPartyA())
				) -
				considering_mm;
		}
		return available;
	}

	/**
	 * @notice Calculates the available balance for Party A.
	 * @param upnl The unrealized profit and loss.
	 * @param partyA The address of Party A.
	 * @return The available balance for Party A.
	 */
	function partyAAvailableBalance(int256 upnl, address partyA) internal view returns (int256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		int256 available;
		if (upnl >= 0) {
			available = int256(accountLayout.allocatedBalances[partyA]) + upnl - int256(accountLayout.lockedBalances[partyA].totalForPartyA());
		} else {
			int256 mm = int256(accountLayout.lockedBalances[partyA].partyAmm);
			int256 considering_mm = -upnl > mm ? -upnl : mm;
			available =
				int256(accountLayout.allocatedBalances[partyA]) -
				int256(accountLayout.lockedBalances[partyA].cva + accountLayout.lockedBalances[partyA].lf) -
				considering_mm;
		}
		return available;
	}

	/**
	 * @notice Calculates the available balance for liquidation for Party A.
	 * @param upnl The unrealized profit and loss.
	 * @param allocatedBalance The allocatedBalance of Party A.
	 * @param partyA The address of Party A.
	 * @return The available balance for liquidation for Party A.
	 */
	function partyAAvailableBalanceForLiquidation(int256 upnl, uint256 allocatedBalance, address partyA) internal view returns (int256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		int256 freeBalance = int256(allocatedBalance) - int256(accountLayout.lockedBalances[partyA].cva + accountLayout.lockedBalances[partyA].lf);
		return freeBalance + upnl;
	}

	/**
	 * @notice Calculates the available balance for a quote for Party B.
	 * @param upnl The unrealized profit and loss.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @return The available balance for a quote for Party B.
	 */
	function partyBAvailableForQuote(int256 upnl, address partyB, address partyA) internal view returns (int256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address allocationKey = partyBAllocationKey(partyB, partyA);
		int256 available;
		if (upnl >= 0) {
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][allocationKey]) +
				upnl -
				int256(
					(accountLayout.partyBLockedBalances[partyB][allocationKey].totalForPartyB() +
						accountLayout.partyBPendingLockedBalances[partyB][allocationKey].totalForPartyB())
				);
		} else {
			int256 mm = int256(accountLayout.partyBLockedBalances[partyB][allocationKey].partyBmm);
			int256 considering_mm = -upnl > mm ? -upnl : mm;
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][allocationKey]) -
				int256(
					(accountLayout.partyBLockedBalances[partyB][allocationKey].cva +
						accountLayout.partyBLockedBalances[partyB][allocationKey].lf +
						accountLayout.partyBPendingLockedBalances[partyB][allocationKey].totalForPartyB())
				) -
				considering_mm;
		}
		return available;
	}

	/**
	 * @notice Calculates the available balance for Party B.
	 * @param upnl The unrealized profit and loss.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @return The available balance for Party B.
	 */
	function partyBAvailableBalance(int256 upnl, address partyB, address partyA) internal view returns (int256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address allocationKey = partyBAllocationKey(partyB, partyA);
		int256 available;
		if (upnl >= 0) {
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][allocationKey]) +
				upnl -
				int256(accountLayout.partyBLockedBalances[partyB][allocationKey].totalForPartyB());
		} else {
			int256 mm = int256(accountLayout.partyBLockedBalances[partyB][allocationKey].partyBmm);
			int256 considering_mm = -upnl > mm ? -upnl : mm;
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][allocationKey]) -
				int256(accountLayout.partyBLockedBalances[partyB][allocationKey].cva + accountLayout.partyBLockedBalances[partyB][allocationKey].lf) -
				considering_mm;
		}
		return available;
	}

	/**
	 * @notice Calculates the available balance for liquidation for Party B.
	 * @param upnl The unrealized profit and loss.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @return The available balance for liquidation for Party B.
	 */
	function partyBAvailableBalanceForLiquidation(int256 upnl, address partyB, address partyA) internal view returns (int256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address allocationKey = partyBAllocationKey(partyB, partyA);
		int256 a = int256(accountLayout.partyBAllocatedBalances[partyB][allocationKey]) -
			int256(accountLayout.partyBLockedBalances[partyB][allocationKey].cva + accountLayout.partyBLockedBalances[partyB][allocationKey].lf);
		return a + upnl;
	}

	/**
	 * @notice Returns the key used for balance allocation mapping in Party B when cross partyB mode enabled.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @return bucket Party B allocation mapping key.
	 */
	function partyBAllocationKey(address partyB, address partyA) internal view returns (address) {
		return MAStorage.layout().crossModeEnabledForPartyB[partyB] ? address(0) : partyA;
	}

	/**
	 * @notice Adds a new quote locked balance to Party B's locked balances. Always updates both per-partyA and cross bucket.
	 * @param quote The quote whose locked values are to be added.
	 */
	function addToPartyBLockedBalances(Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		accountLayout.partyBLockedBalances[quote.partyB][quote.partyA].addQuote(quote);
		accountLayout.partyBLockedBalances[quote.partyB][address(0)].addQuote(quote);
	}

	/**
	 * @notice Subtracts a quote's locked balance from Party B's locked balances. Always updates both per-partyA and cross bucket.
	 * @param quote The quote whose locked values are to be subtracted.
	 */
	function subFromPartyBLockedBalances(Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		accountLayout.partyBLockedBalances[quote.partyB][quote.partyA].subQuote(quote);
		accountLayout.partyBLockedBalances[quote.partyB][address(0)].subQuote(quote);
	}

	/**
	 * @notice Replaces a quote's locked balance in Party B's locked balances with new locked values. Always updates both per-partyA and cross bucket.
	 * @param quote The quote whose locked values are to be replaced.
	 * @param newLockedValues The new locked values to set.
	 */
	function updatePartyBLockedBalances(Quote storage quote, LockedValues memory newLockedValues) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		accountLayout.partyBLockedBalances[quote.partyB][quote.partyA].subQuote(quote).add(newLockedValues);
		accountLayout.partyBLockedBalances[quote.partyB][address(0)].subQuote(quote).add(newLockedValues);
	}

	/**
	 * @notice Adds a new quote locked balance to Party B's pending locked balances. Always updates both per-partyA and cross bucket.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param quote The quote whose locked values are to be added.
	 */
	function addToPartyBPendingLockedBalances(address partyB, address partyA, Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		accountLayout.partyBPendingLockedBalances[partyB][partyA].addQuote(quote);
		accountLayout.partyBPendingLockedBalances[partyB][address(0)].addQuote(quote);
	}

	/**
	 * @notice Subtracts a quote's locked balance from Party B's pending locked balances. Always updates both per-partyA and cross bucket.
	 * @param quote The quote whose locked values are to be subtracted.
	 */
	function subFromPartyBPendingLockedBalances(Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		accountLayout.partyBPendingLockedBalances[quote.partyB][quote.partyA].subQuote(quote);
		accountLayout.partyBPendingLockedBalances[quote.partyB][address(0)].subQuote(quote);
	}

	/**
	 * @notice Increments Party B nonce for a specific Party A. Always increments both per-partyA and cross nonce.
	 * @param partyB PartyB address
	 * @param partyA PartyA address
	 */
	function increasePartyBNonce(address partyB, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		accountLayout.partyBNonces[partyB][partyA]++;
		accountLayout.partyBNonces[partyB][address(0)]++;
	}

	/**
	 * @notice Increments Party A nonce.
	 * @param partyA PartyA address
	 */
	function increasePartyANonce(address partyA) internal {
		AccountStorage.layout().partyANonces[partyA] += 1;
	}

	/**
	 * @notice Increments both Party A and Party B nonces in a single call.
	 * @param partyB PartyB address
	 * @param partyA PartyA address
	 */
	function increaseBothNonces(address partyB, address partyA) internal {
		AccountStorage.layout().partyANonces[partyA] += 1;
		increasePartyBNonce(partyB, partyA);
	}

	/**
	 * @notice returns Party B nonce for standard account mode or cross partyB mode.
	 * @param partyB The Party B address.
	 * @param partyA The Party A address.
	 * @param useCrossNonce Flag to return the actual cross nonce when in cross partyB mode.
	 * @return nonce The Party B nonce in non-cross partyB mode or either zero/actual cross nonce when in cross partyB mode.
	 */
	function getPartyBSignatureNonce(address partyB, address partyA, bool useCrossNonce) internal view returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (MAStorage.layout().crossModeEnabledForPartyB[partyB]) {
			return useCrossNonce ? accountLayout.partyBNonces[partyB][address(0)] : 0;
		}
		return accountLayout.partyBNonces[partyB][partyA];
	}

	/**
	 * @notice Resolves the fee collector address for an affiliate.
	 * @param affiliate The affiliate address.
	 * @return The fee collector address (affiliate-specific or default).
	 */
	function getFeeCollector(address affiliate) internal view returns (address) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		return appLayout.affiliateFeeCollector[affiliate] == address(0)
			? appLayout.defaultFeeCollector
			: appLayout.affiliateFeeCollector[affiliate];
	}

	/**
	 * @notice Refunds the open trading fee for a quote back to Party A's allocated balance.
	 * @param quoteId The ID of the quote whose fee is being refunded.
	 * @param partyA The address of Party A receiving the refund.
	 */
	function refundOpenTradingFee(uint256 quoteId, address partyA) internal {
		uint256 fee = LibQuote.getOpenTradingFee(quoteId);
		AccountStorage.layout().allocatedBalances[partyA] += fee;
		emit SharedEvents.BalanceChangePartyA(partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);
	}
}
