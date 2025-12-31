// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SubAccountDetail, VirtualAccountDetail, VirtualAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { AffiliateState, Stakeholder } from "../../storages/AffiliateHubStorage.sol";

interface IViewFacet {
	// ==================== Sub-Account View Functions ====================

	function getSubAccount(address account) external view returns (SubAccountDetail memory);

	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory);

	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory);

	function getSubAccountsCountOfUser(address owner) external view returns (uint256);

	// ==================== Virtual Account View Functions ====================

	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory);

	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory);

	function getVirtualAccountsOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (VirtualAccountDetail[] memory);

	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory);

	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256);

	// ==================== Single VA Mode ====================

	function getActiveVAByKey(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId) external view returns (address);

	// ==================== Nonce and Prediction ====================

	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256);

	function predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address);

	// ==================== AccountManager ====================

	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address);

	// ==================== Signer and Core ====================

	function getSigner() external view returns (address);

	function getRelatedCore(address account) external view returns (address);

	function ownerOf(address account) external view returns (address);

	function globalNonce() external view returns (uint256);

	function accountManagerImplementation() external view returns (bytes memory);

	// ==================== Affiliate View Functions ====================

	function getAffiliateState(address affiliate) external view returns (AffiliateState);

	function getAffiliateAdmin(address affiliate) external view returns (address);

	function getAffiliateFeeDistributor(address affiliate) external view returns (address);

	function getAffiliateAccountManager(address affiliate) external view returns (address);

	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory);

	function getAffiliateStakeholders(address affiliate) external view returns (Stakeholder[] memory);

	function getAffiliateSymmioShare(address affiliate) external view returns (uint256);

	function isWhitelistedSymmioCore(address core) external view returns (bool);

	function isLegacyMultiAccount(address account) external view returns (bool);

	function getLegacyMultiAccounts() external view returns (address[] memory);

	function getHook(address affiliate, bytes4 selector) external view returns (address);

	function isOperator(address affiliate, bytes4 selector, address operator) external view returns (bool);

	function symmioFeeReceiver() external view returns (address);

	function dryClaimAllFees(address affiliate, address symmio) external view returns (address[] memory holders, uint256[] memory shares);
}
