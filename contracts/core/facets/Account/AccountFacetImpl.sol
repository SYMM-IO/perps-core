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
import { LibMuonAccount } from "../../libraries/muon/LibMuonAccount.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";

library AccountFacetImpl {
	/// @notice Transfers collateral from the signer into the protocol and credits the user's balance.
	function deposit(address user, uint256 amount) internal {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		LibSafeERC20.safeTransferFrom(appLayout.collateral, LibSigner.getSigner(), address(this), amount);
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		AccountStorage.layout().balances[user] += amountWith18Decimals;
	}

	/// @notice Credits a user's balance without transferring tokens, only callable by registered virtual providers.
	function virtualDepositFor(address user, uint256 amount) internal {
		require(WithdrawStorage.layout().virtualProviders[msg.sender], "AccountFacet : msg.sender not registered as virtual provider");
		AccountStorage.layout().balances[user] += amount;
	}

	/// @notice Transfers held funds from a virtual provider to the protocol contract.
	function depositVirtualFunds(uint256 amount) internal {
		require(WithdrawStorage.layout().virtualProviders[msg.sender], "AccountFacet: signer not registered as virtual provider");
		// Transfer funds from virtual provider to Symmio
		address collateral = GlobalAppStorage.layout().collateral;
		LibSafeERC20.safeTransferFrom(collateral, msg.sender, address(this), amount);
	}

	/// @notice Withdraws collateral from the signer's balance and transfers it to the specified user after cooldown verification.
	function withdraw(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		address signer = LibSigner.getSigner();
		require(WithdrawStorage.layout().legacyWithdrawalDeprecated == false, "This Withdrawal has been deprecated use new one;");
		require(
			block.timestamp >= accountLayout.deallocateTimestamp[signer] + MAStorage.layout().withdrawCooldownPeriod,
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

	/// @notice Moves balance from a suspended user's account to a recipient's account without token transfer.
	function withdrawSuspendedUser(address user, address recipient, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		accountLayout.balances[user] -= amountWith18Decimals;
		accountLayout.balances[recipient] += amountWith18Decimals;
	}

	/// @notice Moves funds from a suspended user's allocated balance back to their available balance.
	function deallocateSuspendedUser(address user, uint256 amount) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(accountLayout.allocatedBalances[user] >= amount, "AccountFacet: Insufficient allocated Balance");
		accountLayout.allocatedBalances[user] -= amount;
		accountLayout.balances[user] += amount;
		return accountLayout.allocatedBalances[user];
	}

	/// @notice Moves funds from the user's available balance to their allocated (tradeable) balance.
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

	/// @notice Deallocates funds from the signer's allocated balance after verifying solvency via a Muon UPNL signature.
	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) internal {
		require(!GlobalAppStorage.layout().legacyDeallocateDeprecated, "AccountFacet: Legacy deallocate is disabled");
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(
			block.timestamp >= accountLayout.deallocateTimestamp[signer] + MAStorage.layout().deallocateDebounceTime,
			"AccountFacet: Too many deallocate in a short window"
		);
		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		LibMuonAccount.verifyPartyAUpnl(upnlSig, signer);
		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, signer);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: partyA will be liquidatable");

		_executeDeallocate(signer, amount);
	}

	/// @notice Deallocates funds while also reserving enough balance for off-chain pending operations.
	function safeDeallocate(uint256 amount, SingleUpnlWithPendingBalanceSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(
			block.timestamp >= accountLayout.deallocateTimestamp[signer] + MAStorage.layout().deallocateDebounceTime,
			"AccountFacet: Too many deallocate in a short window"
		);
		require(accountLayout.allocatedBalances[signer] >= amount, "AccountFacet: Insufficient allocated Balance");
		LibMuonAccount.verifyPartyAUpnlWithPendingBalance(upnlSig, signer);
		int256 availableBalance = LibAccount.partyAAvailableForQuote(upnlSig.upnl, signer);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= upnlSig.pendingBalance + amount, "AccountFacet: Insufficient balance considering pending allocations");

		_executeDeallocate(signer, amount);
	}

	/// @notice Deallocates funds without a Muon signature, only allowed when the user has no open or pending positions.
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

	/// @notice Transfers funds from the signer's available balance to the recipient's allocated balance.
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

	/// @notice Transfers funds from the signer's available balance to the recipient's available balance (not allocated).
	function internalTransferToBalance(address user, uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		accountLayout.balances[signer] -= amount;
		accountLayout.balances[user] += amount;
		accountLayout.deallocateTimestamp[user] = block.timestamp;
	}

	/// @notice Executes the deallocation by moving funds from allocated to available balance and recording the timestamp.
	function _executeDeallocate(address signer, uint256 amount) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		accountLayout.allocatedBalances[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.deallocateTimestamp[signer] = block.timestamp;
	}
}
