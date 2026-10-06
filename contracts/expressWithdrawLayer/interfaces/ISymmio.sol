// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title ISymmio
/// @notice Minimal interface for ExpressProvider interactions with SYMMIO core.
interface ISymmio {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function rejectWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function finalizeWithdrawRequest(address user, uint256 requestId) external;
	function advanceWithdraw(address user, uint256 requestId, uint256 amount) external;
	function isSuspended(address user) external view returns (bool);
	function getCollateral() external view returns (address);
	function withdrawCooldownOf(address user) external view returns (uint256);
}
