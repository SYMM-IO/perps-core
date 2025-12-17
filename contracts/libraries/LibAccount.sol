// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../storages/AccountStorage.sol";
import "../storages/QuoteStorage.sol";

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
		address bucketKey = partyBAllocationKey(partyB, partyA);
		return
			accountLayout.partyBPendingLockedBalances[partyB][bucketKey].totalForPartyB() +
			accountLayout.partyBLockedBalances[partyB][bucketKey].totalForPartyB();
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
		address bucketKey = partyBAllocationKey(partyB, partyA);
		int256 available;
		if (upnl >= 0) {
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][bucketKey]) +
				upnl -
				int256(
					(accountLayout.partyBLockedBalances[partyB][bucketKey].totalForPartyB() +
						accountLayout.partyBPendingLockedBalances[partyB][bucketKey].totalForPartyB())
				);
		} else {
			int256 mm = int256(accountLayout.partyBLockedBalances[partyB][bucketKey].partyBmm);
			int256 considering_mm = -upnl > mm ? -upnl : mm;
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][bucketKey]) -
				int256(
					(accountLayout.partyBLockedBalances[partyB][bucketKey].cva +
						accountLayout.partyBLockedBalances[partyB][bucketKey].lf +
						accountLayout.partyBPendingLockedBalances[partyB][bucketKey].totalForPartyB())
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
		address bucketKey = partyBAllocationKey(partyB, partyA);
		int256 available;
		if (upnl >= 0) {
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][bucketKey]) +
				upnl -
				int256(accountLayout.partyBLockedBalances[partyB][bucketKey].totalForPartyB());
		} else {
			int256 mm = int256(accountLayout.partyBLockedBalances[partyB][bucketKey].partyBmm);
			int256 considering_mm = -upnl > mm ? -upnl : mm;
			available =
				int256(accountLayout.partyBAllocatedBalances[partyB][bucketKey]) -
				int256(accountLayout.partyBLockedBalances[partyB][bucketKey].cva + accountLayout.partyBLockedBalances[partyB][bucketKey].lf) -
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
		address bucketKey = partyBAllocationKey(partyB, partyA);
		int256 a = int256(accountLayout.partyBAllocatedBalances[partyB][bucketKey]) -
			int256(accountLayout.partyBLockedBalances[partyB][bucketKey].cva + accountLayout.partyBLockedBalances[partyB][bucketKey].lf);
		return a + upnl;
	}

	/**
	 * @notice Returns the key used for balance allocation mapping in Party B when master account mode enabled.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @return bucket Party B allocation mapping key.
	 */
	function partyBAllocationKey(address partyB, address partyA) internal view returns (address bucket) {
		if (AccountStorage.layout().masterAccountMode[partyB]) {
			bucket = address(0);
		} else {
			bucket = partyA;
		}
	}

	/**
	 * @notice Adds a new quote locked balance to Party B's pending locked balances. In master account mode, adds to both master and specific Party A balances.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param quote The quote whose locked values are to be added.
	 */
	function addToPartyBLockedBalances(address partyB, address partyA, Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (accountLayout.masterAccountMode[partyB]) {
			if (partyA != address(0)) {
				accountLayout.partyBLockedBalances[partyB][partyA].addQuote(quote);
			}
			accountLayout.partyBLockedBalances[partyB][address(0)].addQuote(quote);
		} else {
			accountLayout.partyBLockedBalances[partyB][partyA].addQuote(quote);
		}
	}

	/**
	 * @notice Subtracts a quote's locked balance from Party B's locked balances. In master account mode, subtracts from both master and specific Party A balances.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param quote The quote whose locked values are to be subtracted.
	 */
	function subFromPartyBLockedBalances(address partyB, address partyA, Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (accountLayout.masterAccountMode[partyB]) {
			if (partyA != address(0)) {
				accountLayout.partyBLockedBalances[partyB][partyA].subQuote(quote);
			}
			if (accountLayout.partyBLockedBalances[partyB][address(0)].totalForPartyB() > 0) {
				accountLayout.partyBLockedBalances[partyB][address(0)].subQuote(quote);
			}
		} else {
			accountLayout.partyBLockedBalances[partyB][partyA].subQuote(quote);
		}
	}

	/**
	 * @notice Replaces a quote's locked balance in Party B's locked balances with new locked values. In master account mode, updates both master and specific Party A balances.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param quote The quote whose locked values are to be replaced.
	 * @param newLockedValues The new locked values to set.
	 */
	function replacePartyBLockedBalances(address partyB, address partyA, Quote storage quote, LockedValues memory newLockedValues) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (accountLayout.masterAccountMode[partyB]) {
			if (partyA != address(0)) {
				accountLayout.partyBLockedBalances[partyB][partyA].subQuote(quote).add(newLockedValues);
			}
			if (accountLayout.partyBLockedBalances[partyB][address(0)].totalForPartyB() > 0) {
				accountLayout.partyBLockedBalances[partyB][address(0)].subQuote(quote).add(newLockedValues);
			}
		} else {
			accountLayout.partyBLockedBalances[partyB][partyA].subQuote(quote).add(newLockedValues);
		}
	}

	/**
	 * @notice Adds a new quote locked balance to Party B's pending locked balances. In master account mode, adds to both master and specific Party A balances.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param quote The quote whose locked values are to be added.
	 */
	function addToPartyBPendingLockedBalances(address partyB, address partyA, Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (accountLayout.masterAccountMode[partyB]) {
			if (partyA != address(0)) {
				accountLayout.partyBPendingLockedBalances[partyB][partyA].addQuote(quote);
			}
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].addQuote(quote);
		} else {
			accountLayout.partyBPendingLockedBalances[partyB][partyA].addQuote(quote);
		}
	}

	/**
	 * @notice Subtracts a quote's locked balance from Party B's pending locked balances. In master account mode, subtracts from both master and specific Party A balances.
	 * @param partyB The address of Party B.
	 * @param partyA The address of Party A.
	 * @param quote The quote whose locked values are to be subtracted.
	 */
	function subFromPartyBPendingLockedBalances(address partyB, address partyA, Quote storage quote) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (accountLayout.masterAccountMode[partyB]) {
			if (partyA != address(0)) {
				accountLayout.partyBPendingLockedBalances[partyB][partyA].subQuote(quote);
			}
			if (accountLayout.partyBPendingLockedBalances[partyB][address(0)].totalForPartyB() > 0) {
				accountLayout.partyBPendingLockedBalances[partyB][address(0)].subQuote(quote);
			}
		} else {
			accountLayout.partyBPendingLockedBalances[partyB][partyA].subQuote(quote);
		}
	}

	/**
	 * @notice Increments Party B nonce for a specific Party A. In master account mode, increments both master nonce and specific Party A nonce.
	 * @param partyB PartyB address
	 * @param partyA PartyA address
	 */
	function updatePartyBNonce(address partyB, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		bool isMasterAccountMode = accountLayout.masterAccountMode[partyB];
		if (isMasterAccountMode) {
			accountLayout.partyBNonces[partyB][partyA]++;
			accountLayout.partyBNonces[partyB][address(0)]++;
		}
		else {
			accountLayout.partyBNonces[partyB][partyA]++;
		}
	}

	/**
	 * @notice returns Party B nonce for standard account mode or master account mode.
	 * @param partyB The Party B address.
	 * @param partyA The Party A address.
	 * @param useMasterNonce Flag to return the actual master account nonce when in master account mode.
	 * @return nonce The Party B nonce in non-master account mode or either zero/actual master nonce when in master account mode.
	 */
	function getPartyBSignatureNonce(address partyB, address partyA, bool useMasterNonce) internal view returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (accountLayout.masterAccountMode[partyB]) {
			return useMasterNonce ? accountLayout.partyBNonces[partyB][address(0)] : 0;
		}
		return accountLayout.partyBNonces[partyB][partyA];
	}
}
