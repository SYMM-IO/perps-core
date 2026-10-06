// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Interface for sub-account contracts that act as PartyA on Symmio
interface ISymmioPartyA {
	/// @notice Approves the Symmio core to spend tokens on behalf of this account
	/// @param token The ERC20 token to approve
	/// @param amount The amount to approve
	function _approve(address token, uint256 amount) external;

	/// @notice Executes an arbitrary call to the Symmio core diamond
	/// @param _callData The encoded function call to forward
	/// @return _success Whether the call succeeded
	/// @return _resultData The return data from the call
	function _call(bytes calldata _callData) external returns (bool _success, bytes memory _resultData);

	/// @notice Withdraws ERC20 tokens from this account to the owner
	/// @param token The ERC20 token to withdraw
	/// @param amount The amount to withdraw
	function withdrawERC20(address token, uint256 amount) external;
}
