// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Simplified account view returned by AccountManager for legacy compatibility
struct Account {
	address accountAddress;
	string name;
}

/// @notice Interface for AccountManager -- the per-affiliate proxy that provides a simplified API
interface IAccountManager {
	/// @notice Emitted when a new sub-account is created through the AccountManager
	event AddAccount(address indexed user, address indexed account, string name);

	/// @notice Returns the AccountLayer diamond address this manager is connected to
	/// @return The AccountLayer address
	function getAccountLayer() external view returns (address);

	/// @notice Returns paginated accounts for a user
	/// @param user The user address
	/// @param start The starting index
	/// @param size The maximum number of results
	/// @return The account structs
	function getAccounts(address user, uint256 start, uint256 size) external view returns (Account[] memory);

	/// @notice Returns the total number of accounts for a user
	/// @param user The user address
	/// @return The account count
	function getAccountsLength(address user) external view returns (uint256);
}
