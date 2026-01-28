// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IAccountFacet } from "./IAccountFacet.sol";
import { AccountFacetImpl } from "./AccountFacetImpl.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract AccountFacet is Accessibility, Pausable, IAccountFacet {
	/// @notice Allows either PartyA or PartyB to deposit collateral.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function deposit(uint256 amount) external whenNotAccountingPaused {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.deposit(signer, amount);
		emit Deposit(signer, signer, amount);
		emit Deposit(signer, signer, amount, false);
	}

	/// @notice Allows either Party A or Party B to deposit collateral on behalf of another user.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function depositFor(address user, uint256 amount) external whenNotAccountingPaused {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.deposit(user, amount);
		emit Deposit(signer, user, amount);
		emit Deposit(signer, user, amount, false);
	}

	/// @notice Allows the virtual depositor role to deposit collateral on behalf of another user without actual fund transfer.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function _virtualDepositFor(address user, uint256 amount) internal {
		AccountFacetImpl.virtualDepositFor(user, amount);
		uint256 amountWithCollateralDecimal = (amount * (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals())) / 1e18;
		emit Deposit(msg.sender, user, amountWithCollateralDecimal); // For backward compatibility, will be removed in future
		emit Deposit(msg.sender, user, amountWithCollateralDecimal, true);
	}

	/// @notice Allows the virtual depositor role to deposit collateral on behalf of another user without actual fund transfer.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function virtualDepositFor(address user, uint256 amount) external whenNotAccountingPaused {
		_virtualDepositFor(user, amount);
	}

	/// @notice Allows Virtual Providers to transfer held funds to Symmio.
	/// @param amount The amount of collateral to transfer, specified in collateral decimals.
	function depositVirtualFunds(uint256 amount) external whenNotAccountingPaused {
		AccountFacetImpl.depositVirtualFunds(amount);
		emit DepositVirtualFunds(msg.sender, amount);
	}

	/// @notice Allows the virtual depositor role to deposit collateral on behalf of another user without actual fund transfer and allocate them.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function virtualDepositAndAllocateFor(address user, uint256 amount) external whenNotAccountingPaused {
		_virtualDepositFor(user, amount);
		AccountFacetImpl.allocate(user, amount);
		emit Deposit(msg.sender, user, (amount * (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals())) / 1e18);
		emit AllocatePartyA(user, amount, AccountStorage.layout().allocatedBalances[user]);
		emit SharedEvents.BalanceChangePartyA(user, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows either PartyA or PartyB to withdraw a specified amount of collateral, provided that the withdrawal cooldown period has elapsed.
	/// @param amount The precise amount of collateral to be withdrawn, specified in collateral decimals.
	function withdraw(uint256 amount) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.withdraw(signer, amount);
		emit Withdraw(signer, signer, amount);
	}

	/// @notice Allows either Party A or Party B to withdraw a specified amount of collateral and transfer it to another user, provided that the withdrawal cooldown period has elapsed.
	/// @param user The recipient address for the withdrawal.
	/// @param amount The precise amount of collateral to be withdrawn, specified in collateral decimals.
	function withdrawTo(address user, uint256 amount) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		AccountFacetImpl.withdraw(user, amount);
		emit Withdraw(LibSigner.getSigner(), user, amount);
	}

	/// @notice Allows the system admin to withdraw the balance of a suspended user to a target address.
	/// @param user The suspended user whose funds will be moved.
	/// @param recipient The destination address that will receive the funds.
	/// @param amount The amount to withdraw, specified in collateral decimals.
	function withdrawSuspendedUserFunds(
		address user,
		address recipient,
		uint256 amount
	) external whenNotAccountingPaused onlySuspended(user) onlyRole(LibAccessibility.SUSPENDED_FUNDS_WITHDRAWER_ROLE) {
		AccountFacetImpl.withdrawSuspendedUser(user, recipient, amount);
		emit Withdraw(user, recipient, amount);
		emit WithdrawSuspendedUser(msg.sender, user, recipient, amount);
	}

	/// @notice Allows the system admin to deallocate the funds of a suspended user.
	/// @param user The suspended user whose allocated balance will be reduced.
	/// @param amount The allocated amount to move back to the user's balance, specified in 18 decimals.
	function deallocateSuspendedUserFunds(
		address user,
		uint256 amount
	) external whenNotAccountingPaused onlySuspended(user) onlyRole(LibAccessibility.SUSPENDED_FUNDS_WITHDRAWER_ROLE) {
		uint256 newAllocatedBalance = AccountFacetImpl.deallocateSuspendedUser(user, amount);
		emit DeallocatePartyA(user, amount, newAllocatedBalance);
		emit DeallocateSuspendedUser(msg.sender, user, amount, newAllocatedBalance);
	}

	/// @notice Allows Party A to allocate a specified amount of collateral. Allocated amounts are which user can actually trade on.
	/// @param amount The precise amount of collateral to be allocated, specified in 18 decimals.
	function allocate(
		uint256 amount
	) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.allocate(signer, amount);
		emit AllocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
		emit SharedEvents.BalanceChangePartyA(signer, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows Party A to deposit a specified amount of collateral and immediately allocate it.
	/// @param amount The precise amount of collateral to be deposited and allocated, specified in collateral decimals.
	function depositAndAllocate(
		uint256 amount
	) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) notSuspended(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.deposit(signer, amount);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals());
		AccountFacetImpl.allocate(signer, amountWith18Decimals);
		emit Deposit(signer, signer, amount);
		emit Deposit(signer, signer, amount, false);
		emit AllocatePartyA(signer, amountWith18Decimals, AccountStorage.layout().allocatedBalances[signer]);
		emit SharedEvents.BalanceChangePartyA(signer, amountWith18Decimals, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	function depositAndAllocateFor(address user, uint256 amount) external whenNotAccountingPaused notLiquidatedPartyA(user) notSuspended(user) {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.deposit(user, amount);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals());
		AccountFacetImpl.allocate(user, amountWith18Decimals);
		emit Deposit(signer, user, amount);
		emit Deposit(signer, user, amount, false);
		emit AllocatePartyA(user, amountWith18Decimals, AccountStorage.layout().allocatedBalances[user]);
		emit SharedEvents.BalanceChangePartyA(user, amountWith18Decimals, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows Party A to deallocate a specified amount of collateral.
	/// @param amount The precise amount of collateral to be deallocated, specified in 18 decimals.
	/// @param upnlSig The Muon signature for SingleUpnlSig.
	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.deallocate(amount, upnlSig);
		emit DeallocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
		emit SharedEvents.BalanceChangePartyA(signer, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
	}

	/// @notice Allows Party A to deallocate a specified amount of collateral with pending balance check.
	/// @dev This function considers off-chain pending operations (like solver orders) that need reserved funds.
	/// @param amount The precise amount of collateral to be deallocated, specified in 18 decimals.
	/// @param upnlSig The Muon signature for SingleUpnlWithPendingBalanceSig containing upnl and pendingBalance.
	function safeDeallocate(
		uint256 amount,
		SingleUpnlWithPendingBalanceSig memory upnlSig
	) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.safeDeallocate(amount, upnlSig);
		emit DeallocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
		emit SharedEvents.BalanceChangePartyA(signer, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
	}

	function zeroUpnlDeallocate(uint256 amount) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.zeroUpnlDeallocate(amount, signer);
		emit DeallocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
		emit SharedEvents.BalanceChangePartyA(signer, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
	}

	/// @notice Transfers the sender's deposited balance to the user allocated balance.
	/// @dev The sender and the recipient user cannot be partyB.
	/// @dev PartyA should not be in the liquidation process.
	/// @param user The address of the user to whom the amount will be allocated.
	/// @param amount The amount to transfer and allocate in 18 decimals.
	function internalTransfer(
		address user,
		uint256 amount
	) external whenNotInternalTransferPaused userNotPartyB(user) notSuspended(LibSigner.getSigner()) notSuspended(user) notLiquidatedPartyA(user) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.internalTransfer(user, amount);
		emit InternalTransfer(signer, user, AccountStorage.layout().allocatedBalances[user], amount);
		emit Withdraw(signer, user, ((amount * (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals())) / (10 ** 18)));
		emit AllocatePartyA(user, amount, AccountStorage.layout().allocatedBalances[user]);
		emit SharedEvents.BalanceChangePartyA(user, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Transfers the sender's deposited balance to the user's balance (not allocated balance).
	/// @dev This function is restricted to INTERNAL_TRANSFER_TO_BALANCE_ROLE to prevent cooldown manipulation attacks.
	/// @dev Used by AccountHub when returning funds from virtual accounts to parent accounts.
	/// @param user The address of the user to whom the balance will be transferred.
	/// @param amount The amount to transfer in 18 decimals.
	function internalTransferToBalance(
		address user,
		uint256 amount
	) external whenNotInternalTransferPaused onlyRoleAllowProxy(LibAccessibility.INTERNAL_TRANSFER_TO_BALANCE_ROLE) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.internalTransferToBalance(user, amount);
		emit InternalTransferToBalance(signer, user, AccountStorage.layout().balances[user], amount);
		uint256 amountInCollateralDecimals = (amount * (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals())) / (10 ** 18);
		emit Withdraw(signer, signer, amountInCollateralDecimals);
		emit Deposit(signer, user, amountInCollateralDecimals, false);
	}
}
