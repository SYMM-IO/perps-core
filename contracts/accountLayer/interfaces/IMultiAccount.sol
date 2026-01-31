// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IMultiAccount {
	/// @notice Account struct containing account address and name
	struct Account {
		address accountAddress;
		string name;
	}

	/// @notice Returns the owner of a specific account
	/// @param account The account address to query
	/// @return The owner address
	function owners(address account) external view returns (address);

	/// @notice Returns the Symmio core address this MultiAccount is connected to
	/// @return The Symmio core address
	function symmioAddress() external view returns (address);

	/// @notice Returns the number of accounts belonging to a user
	/// @param user The user address
	/// @return The number of accounts
	function getAccountsLength(address user) external view returns (uint256);

	/// @notice Returns paginated accounts for a user
	/// @param user The user address
	/// @param start The starting index
	/// @param size The maximum number of accounts to return
	/// @return Array of Account structs
	function getAccounts(address user, uint256 start, uint256 size) external view returns (Account[] memory);
}
