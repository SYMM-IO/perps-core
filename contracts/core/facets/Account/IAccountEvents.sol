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
	event DepositVirtualFunds(address indexed provider, uint256 amount);
}
