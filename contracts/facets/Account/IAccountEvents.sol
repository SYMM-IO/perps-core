// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IAccountEvents {
	event Deposit(address sender, address user, uint256 amount); // For backward compatibility, will be removed in future
	event Deposit(address sender, address user, uint256 amount, bool isVirtual);
	event Withdraw(address sender, address user, uint256 amount);
	event WithdrawSuspendedUser(address admin, address user, address recipient, uint256 amount);
	event DeallocateSuspendedUser(address admin, address user, uint256 amount, uint256 newAllocatedBalance);
	event AllocatePartyA(address user, uint256 amount, uint256 newAllocatedBalance);
	event DeallocatePartyA(address user, uint256 amount, uint256 newAllocatedBalance);
	event InternalTransfer(address sender, address user, uint256 userNewAllocatedBalance, uint256 amount);
	event InternalTransferToBalance(address sender, address user, uint256 userNewBalance, uint256 amount);
	event AllocateForPartyB(address partyB, address partyA, uint256 amount, uint256 newAllocatedBalance);
	event DeallocateForPartyB(address partyB, address partyA, uint256 amount, uint256 newAllocatedBalance);
	event TransferAllocation(
		uint256 amount,
		address origin,
		uint256 originNewAllocatedBalance,
		address recipient,
		uint256 recipientNewAllocatedBalance
	);
	event DepositToReserveVault(address sender, address partyB, uint256 amount);
	event WithdrawFromReserveVault(address partyB, uint256 amount);
	event ActivateMasterAccountMode(address user);
	event ExternalTransfer(address indexed sender, address indexed receiver, uint256 amount, address target);
	event BindToPartyB(address partyA, address partyB);
	event CancelUnbindRequest(address partyA);
	event CompleteUnbindRequest(address partyA, address partyB);
	event RequestToUnbindFromPartyB(address partyA);
	//Instant Actions Events
	event ActivateInstantActionMode(address partyA, uint256 time);
	event ProposeToDeactivateInstantActionMode(address partyA, uint256 time);
	event DeactivateInstantActionMode(address partyA, uint256 time);
	event InitiateVirtualExternalTransfer(uint256 id, address sender, address receiver, uint256 amount,address target, address provider);
	event AcceptVirtualExternalTransfer(uint256 id);
	event CancelVirtualExternalTransfer(uint256 id);
}
