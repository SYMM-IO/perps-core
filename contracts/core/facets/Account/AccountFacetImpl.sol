// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { LibMuonAccount } from "../../libraries/muon/LibMuonAccount.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";

library AccountFacetImpl {
	function deposit(address user, uint256 amount) internal {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		LibSafeERC20.safeTransferFrom(appLayout.collateral, LibSigner.getSigner(), address(this), amount);
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		AccountStorage.layout().balances[user] += amountWith18Decimals;
	}

	function virtualDepositFor(address user, uint256 amount) internal {
		require(WithdrawStorage.layout().virtualProviders[msg.sender], "AccountFacet : msg.sender not registered as virtual provider");
		AccountStorage.layout().balances[user] += amount;
	}

	function depositVirtualFunds(uint256 amount) internal {
		require(
			WithdrawStorage.layout().virtualProviders[msg.sender],
			"AccountFacet: signer not registered as virtual provider"
		);
		// Transfer funds from virtual provider to Symmio
		address collateral = GlobalAppStorage.layout().collateral;
		LibSafeERC20.safeTransferFrom(collateral, msg.sender, address(this), amount);
	}

	function withdraw(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		address signer = LibSigner.getSigner();
		require(WithdrawStorage.layout().legacyWithdrawalDeprecated == false, "This Withdrawal has been deprecated use new one;");
		require(
			block.timestamp >= accountLayout.withdrawCooldown[signer] + MAStorage.layout().deallocateCooldown,
			"AccountFacet: Cooldown hasn't reached"
		);
		require(
			IERC20Metadata(appLayout.collateral).balanceOf(address(this)) - withdrawLayout.withdrawLockedBalance >= amount,
			"AccountFacet: Insufficient contract collateral"
		);
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		accountLayout.balances[signer] -= amountWith18Decimals;
		LibSafeERC20.safeTransfer(appLayout.collateral, user, amount);
	}

	function withdrawSuspendedUser(address user, address recipient, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		accountLayout.balances[user] -= amountWith18Decimals;
		accountLayout.balances[recipient] += amountWith18Decimals;
	}

	function deallocateSuspendedUser(address user, uint256 amount) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(accountLayout.allocatedBalances[user] >= amount, "AccountFacet: Insufficient allocated Balance");
		accountLayout.allocatedBalances[user] -= amount;
		accountLayout.balances[user] += amount;
		return accountLayout.allocatedBalances[user];
	}

	function allocate(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(
			accountLayout.allocatedBalances[user] + amount <= GlobalAppStorage.layout().balanceLimitPerUser,
			"AccountFacet: Allocated balance limit reached"
		);
		require(accountLayout.balances[user] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[user] -= amount;
		accountLayout.allocatedBalances[user] += amount;
	}


	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) internal {
		require(!GlobalAppStorage.layout().legacyDeallocateDeprecated, "AccountFacet: Legacy deallocate is disabled");
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(
			block.timestamp >= accountLayout.withdrawCooldown[signer] + MAStorage.layout().deallocateDebounceTime,
			"AccountFacet: Too many deallocate in a short window"
		);
		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		LibMuonAccount.verifyPartyAUpnl(upnlSig, signer);
		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, signer);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: partyA will be liquidatable");

		_executeDeallocate(signer, amount);
	}

	function safeDeallocate(uint256 amount, SingleUpnlWithPendingBalanceSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(
			block.timestamp >= accountLayout.withdrawCooldown[signer] + MAStorage.layout().deallocateDebounceTime,
			"AccountFacet: Too many deallocate in a short window"
		);
		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		LibMuonAccount.verifyPartyAUpnlWithPendingBalance(upnlSig, signer);
		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, signer);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= upnlSig.pendingBalance + amount, "AccountFacet: Insufficient balance considering pending allocations");

		_executeDeallocate(signer, amount);
	}

	function zeroUpnlDeallocate(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		address signer = LibSigner.getSigner();

		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		require(
			quoteLayout.partyAPendingQuotes[partyA].length + quoteLayout.partyAOpenPositions[partyA].length == 0,
			"AccountFacet: PartyA has Open/Pending position"
		);

		_executeDeallocate(signer, amount);
	}

	function internalTransfer(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(
			accountLayout.allocatedBalances[user] + amount <= GlobalAppStorage.layout().balanceLimitPerUser,
			"AccountFacet: Allocated balance limit reached"
		);
		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[signer] -= amount;
		accountLayout.allocatedBalances[user] += amount;
	}

	function internalTransferToBalance(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[signer] -= amount;
		accountLayout.balances[user] += amount;
		accountLayout.withdrawCooldown[user] = block.timestamp;
	}

	function _executeDeallocate(address signer, uint256 amount) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		accountLayout.allocatedBalances[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}
}
