// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SubAccountCreationData, SubAccountDetail } from "../storages/AccountStorage.sol";

/// @notice Subset of the AccountLayer diamond interface used by AccountManager for cross-facet calls
interface IAccountLayerDiamond {
	/// @notice Sets the global signer for protocol-level operations
	/// @param _signer The new signer address
	function setSigner(address _signer) external;

	/// @notice Creates sub-accounts under an affiliate
	/// @param affiliate The affiliate address
	/// @param accountsData Configuration for each sub-account
	/// @return The created sub-account addresses
	function createSubAccounts(address affiliate, SubAccountCreationData[] memory accountsData) external returns (address[] memory);

	/// @notice Executes Symmio core calls on behalf of an account
	/// @param account The account to execute calls for
	/// @param callDatas Array of encoded function calls
	/// @return Array of return data from each call
	function _call(address account, bytes[] calldata callDatas) external returns (bytes[] memory);

	/// @notice Returns the Symmio core associated with an account
	/// @param account The account address
	/// @return The Symmio core address
	function getRelatedCore(address account) external view returns (address);

	/// @notice Returns the number of sub-accounts owned by a user
	/// @param owner The user address
	/// @return The sub-account count
	function getSubAccountsCountOfUser(address owner) external view returns (uint256);

	/// @notice Returns paginated sub-account details owned by a user
	/// @param owner The user address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	/// @return The sub-account detail structs
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory);

	/// @notice Returns Symmio core addresses registered for an affiliate
	/// @param affiliate The affiliate address
	/// @return The array of Symmio core addresses
	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory);
}
