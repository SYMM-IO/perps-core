// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawRequest } from "../storages/WithdrawStorage.sol";

/// @notice Callback interface for express withdrawal providers that front funds to users
interface IExpressProvider {
	/// @notice Called when a new withdrawal request is assigned to this express provider
	/// @param withdrawRequest The withdrawal request details
	/// @param collateral The collateral token address being withdrawn
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address collateral) external;

	/// @notice Called when a withdrawal request handled by this provider completes
	/// @param withdrawRequest The completed withdrawal request
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when a user requests cancellation of a withdrawal handled by this provider
	/// @param withdrawRequest The withdrawal request being cancelled
	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external;

	/// @notice Called when a withdrawal handled by this provider is suspended
	/// @param withdrawRequest The suspended withdrawal request
	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external;
}
