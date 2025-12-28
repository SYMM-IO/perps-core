// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountHub } from "./IAccountHub.sol";

/**
 * @title IAccountHubInternal
 * @notice Internal interface for AccountHub raw storage accessors used by AccountHubLens
 * @dev These functions expose raw storage data for the Lens pattern
 */
interface IAccountHubInternal {
	// Raw storage accessors for sub-accounts
	function getSubAccountRaw(address account) external view returns (IAccountHub.SubAccountDetail memory);
	function getUserSubAccountsCount(address owner) external view returns (uint256);
	function getUserSubAccountAt(address owner, uint256 index) external view returns (address);

	// Raw storage accessors for virtual accounts
	function getVirtualAccountRaw(address account) external view returns (IAccountHub.VirtualAccountDetail memory);
	function getSubAccountVirtualAccountsCount(address subAccount) external view returns (uint256);
	function getSubAccountVirtualAccountAt(address subAccount, uint256 index) external view returns (address);
	function getVirtualAccountQuoteIdsCount(address account) external view returns (uint256);
	function getVirtualAccountQuoteIdAt(address account, uint256 index) external view returns (uint256);

	// Raw storage accessors for single VA mode
	function getActiveVAByKeyRaw(
		address subAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address);

	// Raw storage accessors for nonces
	function getSubAccountVirtualNonceRaw(address subAccount) external view returns (uint256);

	// Raw storage accessors for deleted virtual accounts pool
	function getDeletedVirtualAccountsPoolLength(
		address parentAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (uint256);
	function getDeletedVirtualAccountAt(
		address parentAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId,
		uint256 index
	) external view returns (address);

}
