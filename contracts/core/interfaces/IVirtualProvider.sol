// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawRequest } from "../storages/WithdrawStorage.sol";
import { VirtualExternalTransferRequest } from "../storages/ExternalTransferStorage.sol";

/// @notice Callback interface for virtual providers that handle cross-chain deposits and withdrawals
interface IVirtualProvider {
	/// @notice Called when a new withdrawal request is assigned to this virtual provider
	/// @param withdrawRequest The withdrawal request details
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when a withdrawal request handled by this provider completes
	/// @param withdrawRequest The completed withdrawal request
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when a user requests cancellation of a withdrawal handled by this provider
	/// @param withdrawRequest The withdrawal request being cancelled
	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when the protocol force-cancels a withdrawal handled by this provider
	/// @param withdrawRequest The force-cancelled withdrawal request
	function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when a withdrawal request's cooldown is reduced via speed-up
	/// @param withdrawRequest The withdrawal request being sped up
	/// @param newCooldown The new reduced cooldown duration
	function onSpeedUpWithdrawRequest(WithdrawRequest memory withdrawRequest, uint256 newCooldown) external;

	/// @notice Called when a withdrawal handled by this provider is suspended
	/// @param withdrawRequest The suspended withdrawal request
	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when a virtual external transfer is initiated through this provider
	/// @param externalTransfer The external transfer request details
	function onExternalTransfer(VirtualExternalTransferRequest memory externalTransfer) external;

	/// @notice Called when a virtual external transfer is cancelled
	/// @param id The ID of the cancelled external transfer
	function onCancelExternalTransfer(uint256 id) external;

	/// @notice Called when an express deposit is made through this virtual provider
	/// @param user The user receiving the deposit
	/// @param amount The deposit amount
	/// @param symmioCore The Symmio core diamond address
	function onExpressDeposit(address user, uint256 amount, address symmioCore) external;
}
