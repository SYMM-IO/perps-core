// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../utils/Accessibility.sol";
import "../../utils/Pausable.sol";
import "./IAccountFacet.sol";
import "./AccountFacetImpl.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../libraries/SharedEvents.sol";
import "../../libraries/LibSigner.sol";

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
		AccountFacetImpl.deposit(user, amount);
		emit Deposit(LibSigner.getSigner(), user, amount);
		emit Deposit(LibSigner.getSigner(), user, amount, false);
	}

	/// @notice Allows the virtual depositor role to deposit collateral on behalf of another user without actual fund transfer.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function _virtualDepositFor(address user, uint256 amount) internal {
		AccountFacetImpl.virtualDepositFor(user, amount);
		uint256 amountWithCollateralDecimal = (amount * (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals())) / 1e18;
		emit Deposit(LibSigner.getSigner(), user, amountWithCollateralDecimal); // For backward compatibility, will be removed in future
		emit Deposit(LibSigner.getSigner(), user, amountWithCollateralDecimal, true);
	}

	/// @notice Allows the virtual depositor role to deposit collateral on behalf of another user without actual fund transfer.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function virtualDepositFor(address user, uint256 amount) external whenNotAccountingPaused onlyRole(LibAccessibility.VIRTUAL_DEPOSITOR_ROLE) {
		_virtualDepositFor(user, amount);
	}

	/// @notice Allows the virtual depositor role to deposit collateral on behalf of another user without actual fund transfer and allocate them.
	/// @param user The recipient address for the deposit.
	/// @param amount The amount of collateral to be deposited, specified in collateral decimals.
	function virtualDepositAndAllocateFor(
		address user,
		uint256 amount
	) external whenNotAccountingPaused onlyRole(LibAccessibility.VIRTUAL_DEPOSITOR_ROLE) {
		_virtualDepositFor(user, amount);
		AccountFacetImpl.allocate(user, amount);
		emit Deposit(LibSigner.getSigner(), user, (amount * (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals())) / 1e18);
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
		AccountFacetImpl.deposit(user, amount);
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(GlobalAppStorage.layout().collateral).decimals());
		AccountFacetImpl.allocate(user, amountWith18Decimals);
		emit Deposit(LibSigner.getSigner(), user, amount);
        emit Deposit(LibSigner.getSigner(), user, amount, false);
        emit AllocatePartyA(user, amountWith18Decimals, AccountStorage.layout().allocatedBalances[LibSigner.getSigner()]);
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

	/// @notice Allows Party B to allocate a specified amount of collateral for an specified partyA.
	/// @dev This function can only be called by Party B when Party B actions are not paused and Party B is not liquidated.
	/// @param amount The precise amount of collateral to be allocated, specified in 18 decimals.
	/// @param partyA The address of Party A
	function allocateForPartyB(
		uint256 amount,
		address partyA
	) public whenNotPartyBActionsPaused notLiquidatedPartyB(LibSigner.getSigner(), partyA) onlyPartyB {
		AccountFacetImpl.allocateForPartyB(amount, partyA);
		emit AllocateForPartyB(LibSigner.getSigner(), partyA, amount, AccountStorage.layout().partyBAllocatedBalances[LibSigner.getSigner()][partyA]);
		emit SharedEvents.BalanceChangePartyB(LibSigner.getSigner(), partyA, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows Party B to deallocate a specified amount of collateral
	/// @dev This function can only be called by Party B when Party B actions are not paused and neither Party A nor Party B is liquidated.
	/// @param amount The precise amount of collateral to be deallocated, specified in decimals.
	/// @param partyA The address of Party A
	/// @param upnlSig The Muon signature for SingleUpnlSig.
	function deallocateForPartyB(
		uint256 amount,
		address partyA,
		SingleUpnlSig memory upnlSig
	)
		external
		whenNotPartyBActionsPaused
		notLiquidatedPartyB(LibSigner.getSigner(), partyA)
		notSuspended(LibSigner.getSigner())
		notLiquidatedPartyA(partyA)
		onlyPartyB
	{
		AccountFacetImpl.deallocateForPartyB(amount, partyA, upnlSig);
		emit DeallocateForPartyB(
			LibSigner.getSigner(),
			partyA,
			amount,
			AccountStorage.layout().partyBAllocatedBalances[LibSigner.getSigner()][partyA]
		);
		emit SharedEvents.BalanceChangePartyB(LibSigner.getSigner(), partyA, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
	}

	/// @notice Allows transferring the allocation of partyB from one party A to another.
	/// @param amount The precise amount of collateral to be transferred, specified in decimals.
	/// @param origin The address of the party A whose allocation is being transferred.
	/// @param recipient The address of the party A who will receive the transferred allocation.
	/// @param upnlSig The Muon signature for SingleUpnlSig.
	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) external whenNotPartyBActionsPaused {
		AccountFacetImpl.transferAllocation(amount, origin, recipient, upnlSig);
		emit TransferAllocation(
			amount,
			origin,
			AccountStorage.layout().partyBAllocatedBalances[LibSigner.getSigner()][origin],
			recipient,
			AccountStorage.layout().partyBAllocatedBalances[LibSigner.getSigner()][recipient]
		);
		emit SharedEvents.BalanceChangePartyB(LibSigner.getSigner(), origin, amount, SharedEvents.BalanceChangeType.DEALLOCATE);
		emit SharedEvents.BalanceChangePartyB(LibSigner.getSigner(), recipient, amount, SharedEvents.BalanceChangeType.ALLOCATE);
	}

	/// @notice Allows transferring the balance of partyB to emergency reserve vault.
	/// @param amount The precise amount of collateral to be transferred to emergency reserve vault, specified in 18 decimals.
	function depositToReserveVault(
		uint256 amount,
		address partyB
	) external whenNotPartyBActionsPaused notSuspended(LibSigner.getSigner()) notSuspended(partyB) {
		AccountFacetImpl.depositToReserveVault(amount, partyB);
		emit DepositToReserveVault(LibSigner.getSigner(), partyB, amount);
	}

	/// @notice Allows transferring the balance of partyB in emergency reserve vault to balance.
	/// @param amount The precise amount of collateral to be transferred from emergency reserve vault, specified in 18 decimals.
	function withdrawFromReserveVault(uint256 amount) external whenNotPartyBActionsPaused notSuspended(LibSigner.getSigner()) {
		AccountFacetImpl.withdrawFromReserveVault(amount);
		emit WithdrawFromReserveVault(LibSigner.getSigner(), amount);
	}

	/// @notice Activates master account mode for Party B
	/// @dev Can only be called by Party B when not paused and not suspended
	function activateMasterAccountMode() external whenNotPartyBActionsPaused notSuspended(LibSigner.getSigner()) onlyPartyB {
		AccountFacetImpl.activateMasterAccountMode();
		emit ActivateMasterAccountMode(LibSigner.getSigner());
	}

	/**
	 * @notice Transfers collateral from sender's available balance to whitelisted target without any cooldown
	 * @dev sender must not be suspended/liquidated for the operation to succeed
	 * @param receiver The address of the recipient user in the target contract
	 * @param amount The amount to transfer, specified in collateral decimals
	 * @param target The address of the target contract that will receive the collateral
	 */
	function externalTransfer(
		address receiver,
		uint256 amount,
		address target
	) external whenNotExternalTransferPaused notSuspended(LibSigner.getSigner()) notLiquidatedPartyA(LibSigner.getSigner()) {
		AccountFacetImpl.externalTransfer(LibSigner.getSigner(), receiver, amount, target);
		emit ExternalTransfer(LibSigner.getSigner(), receiver, amount, target);
	}

	/**
     * @notice Transfers virtual collateral fund from sender's available balance in this Symmio Diamond to another Symmio Diamond
	 * @dev sender must not be suspended/liquidated for the operation to succeed
	 * @param receiver The address of the recipient user in the target contract
	 * @param amount The amount to transfer, specified in collateral decimals
	 * @param target The target Symmio contract
	 * @param virtualProvider The provider who can virtualDeposit fund to target Symmio contract
	 */
	function virtualExternalTransfer(
		address receiver,
		uint256 amount,
		address target,
		address virtualProvider
	) external whenNotExternalTransferPaused notSuspended(msg.sender) notLiquidatedPartyA(msg.sender) {
		uint256 id = AccountFacetImpl.virtualExternalTransfer(msg.sender, receiver, amount, target,virtualProvider);
		emit InitiateVirtualExternalTransfer(id,msg.sender, receiver, amount,target,virtualProvider);
	}

	/**
	* @notice Accepts a virtual external transfer that was previously initiated
	* @dev Can be called by the receiver of the virtual external transfer when not paused
	* @param id The ID of the virtual external transfer to accept
	*/
	function acceptVirtualExternalTransfer(uint256 id) external whenNotExternalTransferPaused {
		AccountFacetImpl.acceptVirtualExternalTransfer(id);
		emit AcceptVirtualExternalTransfer(id);
	}
	/**
	* @notice Cancels a previously initiated virtual external transfer.
	* @dev Delegates cancellation logic to AccountFacetImpl.cancelVirtualExternalTransfer(id).
	*      Emits {CancelVirtualExternalTransfer}. Callable only when external transfers are not paused;
	*      reverts if the transfer does not exist or the caller is not authorized per implementation rules.
	* @param id The identifier of the virtual external transfer to cancel.
	*/
	function cancelVirtualExternalTransfer(uint256 id) external whenNotExternalTransferPaused {
		AccountFacetImpl.cancelVirtualExternalTransfer(id);
		emit CancelVirtualExternalTransfer(id);
	}

	/// @notice Allows Party A to bind to Party B
	/// @dev Can only be called by Party A when not suspended
	/// @param partyB The address of Party B
	function bindToPartyB(address partyB) external notSuspended(LibSigner.getSigner()) userNotPartyB(LibSigner.getSigner()) {
		AccountFacetImpl.bindToPartyB(partyB);
		emit BindToPartyB(partyB, LibSigner.getSigner());
	}

	/// @notice Allows Party A to request to unbind from Party B
	/// @dev Can only be called by Party A when not suspended
	function requestToUnbindFromPartyB() external notSuspended(LibSigner.getSigner()) userNotPartyB(LibSigner.getSigner()) {
		AccountFacetImpl.requestToUnbindFromPartyB();
		emit RequestToUnbindFromPartyB(LibSigner.getSigner());
	}

	/// @notice Allows Party A to cancel the unbind request from Party B
	/// @dev Can only be called by Party A when not suspended
	function cancelUnbindRequest() external notSuspended(LibSigner.getSigner()) userNotPartyB(LibSigner.getSigner()) {
		AccountFacetImpl.cancelUnbindRequest();
		emit CancelUnbindRequest(LibSigner.getSigner());
	}

	/// @notice Allows Party B to complete the unbind request from Party A
	/// @dev Can be called by PartyA after cooldown or partyB right away
	/// @param partyA The address of Party A
	function completeUnbindRequest(address partyA) external notSuspended(LibSigner.getSigner()) {
		AccountFacetImpl.completeUnbindRequest(partyA);
		emit CompleteUnbindRequest(partyA, LibSigner.getSigner());
	}

	/**
	 * @notice Enables the instant action mode for a PartyA
	 * @dev Only callable by PartyA accounts, not PartyB
	 */
	function activateInstantActionMode()
		external
		userNotPartyB(LibSigner.getSigner())
		whenInstantModeIsNotActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
	{
		AccountFacetImpl.activateInstantActionMode();
		emit ActivateInstantActionMode(LibSigner.getSigner(), block.timestamp);
	}

	/**
	 * @notice Initiates the process to deactivate instant action mode
	 * @dev Only callable by PartyA accounts, starts a time-delayed process
	 */
	function proposeToDeactivateInstantActionMode()
		external
		userNotPartyB(LibSigner.getSigner())
		whenInstantModeIsActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
	{
		AccountFacetImpl.proposeToDeactivateInstantActionMode();
		emit ProposeToDeactivateInstantActionMode(LibSigner.getSigner(), block.timestamp);
	}

	/**
	 * @notice Completes the deactivation of instant action mode after proposal
	 * @dev Only callable by PartyA accounts after the waiting period has passed
	 */
	function deactivateInstantActionMode() external userNotPartyB(LibSigner.getSigner()) whenNotPartyAActionsPaused {
		AccountFacetImpl.deactivateInstantActionMode();
		emit DeactivateInstantActionMode(LibSigner.getSigner(), block.timestamp);
	}
}
