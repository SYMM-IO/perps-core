// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./IAccountHub.sol";

interface IAccountHubLens {
	// View functions for sub-accounts
	function getSubAccount(address account) external view returns (IAccountHub.SubAccountDetail memory);
	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory);
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (IAccountHub.SubAccountDetail[] memory details);
	function getSubAccountsCountOfUser(address owner) external view returns (uint256);

	// View functions for virtual accounts
	function getVirtualAccount(address account) external view returns (IAccountHub.VirtualAccountDetail memory);
	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory);
	function getVirtualAccountsOfSubAccount(
		address subAccount,
		uint256 offset,
		uint256 limit
	) external view returns (IAccountHub.VirtualAccountDetail[] memory details);
	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory);
	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256);

	// Single VA Mode
	function getActiveVAByKey(
		address subAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address);

	// Virtual account nonce and prediction
	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256);
	function predictNextVirtualAccountAddress(
		address subAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address);

	// AccountManager
	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address);
}
