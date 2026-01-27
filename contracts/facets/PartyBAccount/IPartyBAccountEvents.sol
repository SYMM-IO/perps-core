// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IPartyBAccountEvents {
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
}
