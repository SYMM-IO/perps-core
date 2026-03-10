// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SubAccountDetail, VirtualAccountDetail, VirtualAccountIsolationType, LegacyAccountInfo } from "../../storages/AccountStorage.sol";
import { AffiliateState, Stakeholder } from "../../storages/AffiliateStorage.sol";

/// @notice Read-only interface for accounts, affiliates, roles, and system state
interface IViewFacet {
	// ==================== Sub-Account View Functions ====================

	/// @notice Returns the full details of a sub-account
	/// @param account The sub-account address
	function getSubAccount(address account) external view returns (SubAccountDetail memory);

	/// @notice Returns paginated sub-account addresses owned by a user
	/// @param owner The user address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory);

	/// @notice Returns paginated sub-account details owned by a user
	/// @param owner The user address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory);

	/// @notice Returns the total number of sub-accounts owned by a user
	/// @param owner The user address
	function getSubAccountsCountOfUser(address owner) external view returns (uint256);

	// ==================== Virtual Account View Functions ====================

	/// @notice Returns the full details of a virtual account
	/// @param account The virtual account address
	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory);

	/// @notice Returns paginated virtual account addresses belonging to a sub-account
	/// @param subAccount The parent sub-account address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory);

	/// @notice Returns paginated virtual account details belonging to a sub-account
	/// @param subAccount The parent sub-account address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	function getVirtualAccountsOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (VirtualAccountDetail[] memory);

	/// @notice Returns paginated quote IDs tracked by a virtual account
	/// @param account The virtual account address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory);

	/// @notice Returns the number of active virtual accounts under a sub-account
	/// @param subAccount The parent sub-account address
	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256);

	// ==================== Single VA Mode ====================

	/// @notice Returns the active VA for a given isolation key in singleVAMode
	/// @param subAccount The parent sub-account address
	/// @param isolationType The isolation type
	/// @param symbolId The symbol identifier
	function getActiveVAByKey(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId) external view returns (address);

	// ==================== Nonce and Prediction ====================

	/// @notice Returns the current virtual account nonce for a sub-account
	/// @param subAccount The sub-account address
	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256);

	/// @notice Predicts the next virtual account address for a given isolation key
	/// @param subAccount The parent sub-account address
	/// @param isolationType The isolation type
	/// @param symbolId The symbol identifier
	function predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address);

	// ==================== AccountManager ====================

	/// @notice Computes the next deterministic address for an AccountManager
	/// @param registrant The registrant address
	/// @param name The affiliate name
	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address);

	// ==================== Signer and Core ====================

	/// @notice Returns the current effective signer
	function getSigner() external view returns (address);

	/// @notice Returns the Symmio core address associated with an account
	/// @param account The account address
	function getRelatedCore(address account) external view returns (address);

	/// @notice Resolves the owner of an account
	/// @param account The account address
	function ownerOf(address account) external view returns (address);

	/// @notice Returns the global nonce used for sub-account address generation
	function globalNonce() external view returns (uint256);

	/// @notice Returns the current AccountManager proxy bytecode
	function accountManagerImplementation() external view returns (bytes memory);

	// ==================== Affiliate View Functions ====================

	/// @notice Returns the registration state of an affiliate
	/// @param affiliate The affiliate address
	function getAffiliateState(address affiliate) external view returns (AffiliateState);

	/// @notice Returns the admin address of an affiliate
	/// @param affiliate The affiliate address
	function getAffiliateAdmin(address affiliate) external view returns (address);

	/// @notice Returns the fee distributor address of an affiliate
	/// @param affiliate The affiliate address
	function getAffiliateFeeDistributor(address affiliate) external view returns (address);

	/// @notice Returns the Symmio core addresses registered for an affiliate
	/// @param affiliate The affiliate address
	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory);

	/// @notice Returns the fee stakeholders for an affiliate
	/// @param affiliate The affiliate address
	function getAffiliateStakeholders(address affiliate) external view returns (Stakeholder[] memory);

	/// @notice Returns the Symmio share of fees for an affiliate
	/// @param affiliate The affiliate address
	function getAffiliateSymmioShare(address affiliate) external view returns (uint256);

	/// @notice Checks whether a Symmio core address is whitelisted
	/// @param core The Symmio core address
	function isWhitelistedSymmioCore(address core) external view returns (bool);

	/// @notice Checks whether an address is a registered legacy MultiAccount contract
	/// @param account The address to check
	function isLegacyMultiAccount(address account) external view returns (bool);

	/// @notice Returns all registered legacy MultiAccount contract addresses
	function getLegacyMultiAccounts() external view returns (address[] memory);

	/// @notice Returns legacy accounts owned by a user across all legacy contracts
	/// @param owner The user address
	/// @param maxResults The maximum number of results
	function getLegacyAccountsOfUser(address owner, uint256 maxResults) external view returns (LegacyAccountInfo[] memory accounts, bool hasMore);

	/// @notice Returns the hook contract for an affiliate's function selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector
	function getHook(address affiliate, bytes4 selector) external view returns (address);

	/// @notice Checks whether an address is an authorized operator for an affiliate's selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector
	/// @param operator The operator address
	function isOperator(address affiliate, bytes4 selector, address operator) external view returns (bool);

	/// @notice Returns the Symmio fee receiver address
	function symmioFeeReceiver() external view returns (address);

	/// @notice Simulates claiming all fees and returns the distribution per stakeholder
	/// @param affiliate The affiliate address
	/// @param symmio The Symmio core address
	function dryClaimAllFees(address affiliate, address symmio) external view returns (address[] memory holders, uint256[] memory shares);

	/// @notice Returns the maximum allowed name length
	function MAX_NAME_LENGTH() external view returns (uint256);

	// ==================== Role Management ====================

	/// @notice Checks whether a user has a specific role
	/// @param user The user address
	/// @param role The role identifier
	function hasRole(address user, bytes32 role) external view returns (bool);

	/// @notice Checks whether a user is a role admin for a specific role
	/// @param user The user address
	/// @param role The role identifier
	function isRoleAdmin(address user, bytes32 role) external view returns (bool);

	// ==================== Pause Control ====================

	/// @notice Returns whether the AccountLayer diamond is paused
	function paused() external view returns (bool);
}
