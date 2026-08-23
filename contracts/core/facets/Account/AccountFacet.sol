// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IAccountFacet } from "./IAccountFacet.sol";
import { AccountFacetImpl } from "./AccountFacetImpl.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { OperationalFeeStorage, AllowanceState } from "../../storages/OperationalFeeStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibOperationalFee } from "../../libraries/LibOperationalFee.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";

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

	/// @notice Allows a registered virtual provider to deposit collateral on behalf of another user without actual fund transfer.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in 18 decimals.
	function _virtualDepositFor(address user, uint256 amount) internal {
		AccountFacetImpl.virtualDepositFor(user, amount);
		uint256 amountWithCollateralDecimal = LibAccount.toCollateralDecimals(amount);
		emit Deposit(msg.sender, user, amountWithCollateralDecimal); // For backward compatibility, will be removed in future
		emit Deposit(msg.sender, user, amountWithCollateralDecimal, true);
	}

	/// @notice Allows a registered virtual provider to deposit collateral on behalf of another user without actual fund transfer.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in 18 decimals.
	function virtualDepositFor(address user, uint256 amount) external whenNotAccountingPaused {
		_virtualDepositFor(user, amount);
	}

	/// @notice Allows Virtual Providers to transfer held funds to Symmio.
	/// @param amount The amount of collateral to transfer, specified in collateral decimals.
	function depositVirtualFunds(uint256 amount) external whenNotAccountingPaused {
		AccountFacetImpl.depositVirtualFunds(amount);
		emit DepositVirtualFunds(msg.sender, amount);
	}

	/// @notice Allows a registered virtual provider to deposit collateral on behalf of another user without actual fund transfer and allocate them.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in 18 decimals.
	function virtualDepositAndAllocateFor(address user, uint256 amount) external whenNotAccountingPaused notLiquidatedPartyA(user) {
		_virtualDepositFor(user, amount);
		AccountFacetImpl.allocate(user, amount);
		emit AllocatePartyA(user, amount, AccountStorage.layout().allocatedBalances[user]);
	}

	/// @notice Allows either PartyA or PartyB to withdraw a specified amount of collateral, provided that the withdrawal cooldown period has elapsed.
	/// @param amount The precise amount of collateral to be withdrawn, specified in collateral decimals.
	function withdraw(uint256 amount) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.withdraw(signer, amount);
		emit Withdraw(signer, signer, amount);
	}

	/// @notice Allows PartyA or PartyB to withdraw collateral to another user after the withdrawal cooldown elapses.
	/// @param user The recipient address for the withdrawal.
	/// @param amount The precise amount of collateral to be withdrawn, specified in collateral decimals.
	function withdrawTo(address user, uint256 amount) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		AccountFacetImpl.withdraw(user, amount);
		emit Withdraw(LibSigner.getSigner(), user, amount);
	}

	/// @notice Allows SUSPENDED_FUNDS_WITHDRAWER_ROLE to transfer a suspended user's internal balance
	///         to a recipient without transferring tokens.
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

	/// @notice Allows the SUSPENDED_FUNDS_WITHDRAWER_ROLE to deallocate the funds of a suspended user.
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

	/// @notice Allows PartyA to allocate collateral. The allocated balance is available for trading.
	/// @param amount The precise amount of collateral to be allocated, specified in 18 decimals.
	function allocate(
		uint256 amount
	) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.allocate(signer, amount);
		emit AllocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
	}

	/// @notice Allows Party A to deposit a specified amount of collateral and immediately allocate it.
	/// @param amount The precise amount of collateral to be deposited and allocated, specified in collateral decimals.
	function depositAndAllocate(
		uint256 amount
	) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) notSuspended(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.deposit(signer, amount);
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		AccountFacetImpl.allocate(signer, amountWith18Decimals);
		emit Deposit(signer, signer, amount);
		emit Deposit(signer, signer, amount, false);
		emit AllocatePartyA(signer, amountWith18Decimals, AccountStorage.layout().allocatedBalances[signer]);
	}

	/// @notice Deposits collateral on behalf of another user and immediately allocates it for trading.
	/// @param user The recipient address for the deposit and allocation.
	/// @param amount The amount of collateral to deposit and allocate, specified in collateral decimals.
	function depositAndAllocateFor(address user, uint256 amount) external whenNotAccountingPaused notLiquidatedPartyA(user) notSuspended(user) {
		address signer = LibSigner.getSigner();
		AccountFacetImpl.deposit(user, amount);
		uint256 amountWith18Decimals = LibAccount.to18Decimals(amount);
		AccountFacetImpl.allocate(user, amountWith18Decimals);
		emit Deposit(signer, user, amount);
		emit Deposit(signer, user, amount, false);
		emit AllocatePartyA(user, amountWith18Decimals, AccountStorage.layout().allocatedBalances[user]);
	}

	/// @notice Allows Party A to deallocate a specified amount of collateral.
	/// @param amount The precise amount of collateral to be deallocated, specified in 18 decimals.
	/// @param upnlSig The Muon signature for SingleUpnlSig.
	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.deallocate(amount, upnlSig);
		emit DeallocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
	}

	/// @notice Allows Party A to deallocate a specified amount of collateral with pending balance check.
	/// @dev This function considers off-chain pending operations (like solver orders) that need reserved funds.
	/// @param amount The precise amount of collateral to be deallocated, specified in 18 decimals.
	/// @param upnlSig The Muon signature containing UPNL, funding debt, pending balance, and the scaled locked balance.
	function safeDeallocate(
		uint256 amount,
		SingleUpnlWithPendingBalanceSig memory upnlSig
	) external whenNotAccountingPaused notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.safeDeallocate(amount, upnlSig);
		emit DeallocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
	}

	/// @notice Deallocates collateral without requiring a Muon UPNL signature, only when the user has no open or pending positions.
	/// @param amount The amount of collateral to deallocate, specified in 18 decimals.
	function zeroUpnlDeallocate(uint256 amount) external onlyRoleAllowProxy(LibAccessibility.BALANCE_SETTLER_ROLE) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.zeroUpnlDeallocate(amount, signer);
		emit DeallocatePartyA(signer, amount, AccountStorage.layout().allocatedBalances[signer]);
	}

	/// @notice Transfers the sender's deposited balance to the user allocated balance.
	/// @dev The recipient user cannot be partyB.
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
		emit Withdraw(signer, user, LibAccount.toCollateralDecimals(amount));
		emit AllocatePartyA(user, amount, AccountStorage.layout().allocatedBalances[user]);
	}

	/// @notice Transfers the sender's deposited balance to the user's balance (not allocated balance).
	/// @dev This function is restricted to BALANCE_SETTLER_ROLE to prevent cooldown manipulation attacks.
	/// @dev Used by AccountLayer when returning funds from virtual accounts to parent accounts.
	/// @param user The address of the user to whom the balance will be transferred.
	/// @param amount The amount to transfer in 18 decimals.
	function internalTransferToBalance(address user, uint256 amount) external onlyRoleAllowProxy(LibAccessibility.BALANCE_SETTLER_ROLE) {
		address signer = LibSigner.getSigner();

		AccountFacetImpl.internalTransferToBalance(user, amount);
		emit InternalTransferToBalance(signer, user, AccountStorage.layout().balances[user], amount);
		uint256 amountInCollateralDecimals = LibAccount.toCollateralDecimals(amount);
		emit Withdraw(signer, signer, amountInCollateralDecimals);
		emit Deposit(signer, user, amountInCollateralDecimals);
		emit Deposit(signer, user, amountInCollateralDecimals, false);
	}

	/// @notice Charge a standing operational fee from `payer`'s balance. Caller (msg.sender) is the charger.
	/// @dev Free-first then allocated; the allocated portion is guarded by balance only (no oracle sig here).
	///      Payer guards (suspended / under-liquidation) live in LibOperationalFee.charge so the solver path
	///      enforces them too. No reentrancy guard: the charge path is pure storage + events with no external
	///      call, so it cannot be re-entered (consistent with this facet's other balance methods).
	function chargeOperationalFee(address payer, uint256 amount) external whenNotAccountingPaused {
		LibOperationalFee.charge(payer, msg.sender, amount);
	}

	function _setOperationalFeeAllowance(address payer, address charger, uint256 amount) private {
		LibOperationalFee.setAllowance(payer, charger, amount);
		AllowanceState storage s = OperationalFeeStorage.layout().allowances[payer][charger];
		if (s.reductionReadyAt != 0 && s.pendingAllowance == amount) {
			emit OperationalFeeAllowanceReductionRequested(payer, charger, amount, s.reductionReadyAt);
		} else {
			emit OperationalFeeAllowanceSet(payer, charger, amount);
		}
	}

	/// @notice ERC20-approve-style: set each charger's remaining operational-fee allowance to an absolute amount.
	/// @dev Batch so a payer can approve multiple chargers (e.g. a solver and a relayer) in one tx.
	///      Per charger: a raise (or equal) applies instantly; a reduction is timelocked (see LibOperationalFee).
	function approveOperationalFee(address[] calldata chargers, uint256[] calldata amounts) external {
		require(chargers.length == amounts.length, "AccountFacet: Length mismatch");
		address payer = LibSigner.getSigner();
		for (uint256 i = 0; i < chargers.length; i++) {
			_setOperationalFeeAllowance(payer, chargers[i], amounts[i]);
		}
	}

	/// @notice Set allowance and the charger's priority multiplier in one call. 10000 is the normal 1x multiplier.
	function approveOperationalFeeWithMultiplier(
		address[] calldata chargers,
		uint256[] calldata amounts,
		uint256[] calldata feeMultipliers
	) external {
		require(chargers.length == amounts.length && chargers.length == feeMultipliers.length, "AccountFacet: Length mismatch");
		address payer = LibSigner.getSigner();
		for (uint256 i = 0; i < chargers.length; i++) {
			_setOperationalFeeAllowance(payer, chargers[i], amounts[i]);
			LibOperationalFee.setFeeMultiplier(payer, chargers[i], feeMultipliers[i]);
			emit OperationalFeeMultiplierSet(payer, chargers[i], feeMultipliers[i]);
		}
	}
}
