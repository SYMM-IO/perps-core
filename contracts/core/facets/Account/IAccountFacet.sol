// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountEvents } from "./IAccountEvents.sol";
import { SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";

interface IAccountFacet is IAccountEvents {
	//Party A
	function deposit(uint256 amount) external;

	function depositFor(address user, uint256 amount) external;

	function virtualDepositFor(address user, uint256 amount) external;

	function depositVirtualFunds(uint256 amount) external;

	function withdraw(uint256 amount) external;

	function withdrawTo(address user, uint256 amount) external;

	function withdrawSuspendedUserFunds(address user, address recipient, uint256 amount) external;

	function deallocateSuspendedUserFunds(address user, uint256 amount) external;

	function allocate(uint256 amount) external;

	function depositAndAllocate(uint256 amount) external;

	function depositAndAllocateFor(address user, uint256 amount) external;

	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) external;

	function safeDeallocate(uint256 amount, SingleUpnlWithPendingBalanceSig memory upnlSig) external;

	function zeroUpnlDeallocate(uint256 amount) external;

	function internalTransfer(address user, uint256 amount) external;

	function internalTransferToBalance(address user, uint256 amount) external;

	function chargeOperationalFee(address payer, uint256 amount) external;

	function approveOperationalFee(address[] calldata chargers, uint256[] calldata amounts) external;

	function approveOperationalFeeWithMultiplier(address[] calldata chargers, uint256[] calldata amounts, uint256[] calldata feeMultipliers) external;
}
