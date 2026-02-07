// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IViewFacet } from "./IViewFacet.sol";
import {
	AccountHubStorage,
	SubAccountData,
	SubAccountDetail,
	VirtualAccountData,
	VirtualAccountDetail,
	VirtualAccountIsolationType,
	LegacyAccountInfo
} from "../../storages/AccountHubStorage.sol";
import { AccountLayerStorage } from "../../storages/AccountLayerStorage.sol";
import { AffiliateHubStorage, AffiliateState, Stakeholder } from "../../storages/AffiliateHubStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";

contract ViewFacet is IViewFacet {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");
	uint256 private constant SHARE_PRECISION = 1e18;

	// ==================== Sub-Account View Functions ====================

	function getSubAccount(address account) external view returns (SubAccountDetail memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		SubAccountData storage s = ahLayout.subAccounts[account];
		return
			SubAccountDetail({
				accountAddress: account,
				owner: s.owner,
				name: s.name,
				isExists: s.isExists,
				singleVAMode: s.singleVAMode,
				affiliate: s.affiliate,
				symmioCore: s.symmioCore,
				metadata: s.metadata,
				isolationType: s.isolationType
			});
	}

	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		uint256 total = ahLayout.userToSubAccounts[owner].length();
		if (offset >= total) {
			return new address[](0);
		}
		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;
		address[] memory paginatedAddresses = new address[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			paginatedAddresses[i] = ahLayout.userToSubAccounts[owner].at(offset + i);
		}
		return paginatedAddresses;
	}

	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory details) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		uint256 total = ahLayout.userToSubAccounts[owner].length();

		if (offset >= total) {
			return new SubAccountDetail[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		details = new SubAccountDetail[](resultSize);

		for (uint256 i = 0; i < resultSize; i++) {
			address accountAddr = ahLayout.userToSubAccounts[owner].at(offset + i);
			SubAccountData storage s = ahLayout.subAccounts[accountAddr];
			details[i] = SubAccountDetail({
				accountAddress: accountAddr,
				owner: s.owner,
				name: s.name,
				isExists: s.isExists,
				singleVAMode: s.singleVAMode,
				affiliate: s.affiliate,
				symmioCore: s.symmioCore,
				metadata: s.metadata,
				isolationType: s.isolationType
			});
		}
	}

	function getSubAccountsCountOfUser(address owner) external view returns (uint256) {
		return AccountHubStorage.layout().userToSubAccounts[owner].length();
	}

	// ==================== Virtual Account View Functions ====================

	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		VirtualAccountData storage v = ahLayout.virtualAccounts[account];
		return
			VirtualAccountDetail({
				accountAddress: account,
				parentAccount: v.parentAccount,
				symbolId: v.symbolId,
				metadata: v.metadata,
				isExists: v.isExists,
				isolationType: v.isolationType
			});
	}

	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		uint256 total = ahLayout.subAccountToVirtualAccounts[subAccount].length();

		if (offset >= total) {
			return new address[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		address[] memory paginatedAccounts = new address[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			paginatedAccounts[i] = ahLayout.subAccountToVirtualAccounts[subAccount].at(offset + i);
		}
		return paginatedAccounts;
	}

	function getVirtualAccountsOfSubAccount(
		address subAccount,
		uint256 offset,
		uint256 limit
	) external view returns (VirtualAccountDetail[] memory details) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		uint256 total = ahLayout.subAccountToVirtualAccounts[subAccount].length();

		if (offset >= total) {
			return new VirtualAccountDetail[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		details = new VirtualAccountDetail[](resultSize);

		for (uint256 i = 0; i < resultSize; i++) {
			address accountAddr = ahLayout.subAccountToVirtualAccounts[subAccount].at(offset + i);
			VirtualAccountData storage v = ahLayout.virtualAccounts[accountAddr];
			details[i] = VirtualAccountDetail({
				accountAddress: accountAddr,
				parentAccount: v.parentAccount,
				symbolId: v.symbolId,
				metadata: v.metadata,
				isExists: v.isExists,
				isolationType: v.isolationType
			});
		}
	}

	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		uint256 total = ahLayout.virtualAccounts[account].quoteIds.length();

		if (offset >= total) {
			return new uint256[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		uint256[] memory paginatedQuoteIds = new uint256[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			paginatedQuoteIds[i] = ahLayout.virtualAccounts[account].quoteIds.at(offset + i);
		}
		return paginatedQuoteIds;
	}

	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256) {
		return AccountHubStorage.layout().subAccountToVirtualAccounts[subAccount].length();
	}

	// ==================== Single VA Mode ====================

	function getActiveVAByKey(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId) external view returns (address) {
		return AccountHubStorage.layout().activeVAByKey[subAccount][isolationType][symbolId];
	}

	// ==================== Nonce and Prediction ====================

	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256) {
		return AccountHubStorage.layout().subAccountVirtualNonces[subAccount];
	}

	function predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		// First check if a deleted virtual account exists for this combination
		uint256 poolLength = ahLayout.deletedVirtualAccountsPool[subAccount][isolationType][symbolId].length;
		if (poolLength > 0) {
			return ahLayout.deletedVirtualAccountsPool[subAccount][isolationType][symbolId][poolLength - 1];
		}

		// If singleVAMode is enabled, check if there's already an active VA for this key
		if (ahLayout.subAccounts[subAccount].singleVAMode) {
			address existingVA = ahLayout.activeVAByKey[subAccount][isolationType][symbolId];
			if (existingVA != address(0) && ahLayout.virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		// If no deleted account exists, generate and return a new virtual account address
		uint256 nextNonce = ahLayout.subAccountVirtualNonces[subAccount] + 1;
		return LibAccountLayerUtils.generateVirtualAccountAddress(subAccount, nextNonce);
	}

	// ==================== AccountManager ====================

	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, registrant, name));
		bytes memory bytecode = abi.encodePacked(ahLayout.accountManagerImplementation, abi.encode(address(this)));
		bytes32 initCodeHash = keccak256(bytecode);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
	}

	// ==================== Signer and Core ====================

	function getSigner() public view returns (address) {
		return LibAccountLayerUtils.getSigner();
	}

	function getRelatedCore(address account) public view returns (address) {
		return LibAccountLayerUtils.getRelatedCore(account);
	}

	function ownerOf(address account) external view returns (address) {
		return LibAccountLayerUtils.resolveAccountOwner(account);
	}

	function globalNonce() external view returns (uint256) {
		return AccountHubStorage.layout().globalNonce;
	}

	function accountManagerImplementation() external view returns (bytes memory) {
		return AccountHubStorage.layout().accountManagerImplementation;
	}

	// ==================== Affiliate View Functions ====================

	function getAffiliateState(address affiliate) external view returns (AffiliateState) {
		return AffiliateHubStorage.layout().affiliates[affiliate].state;
	}

	function getAffiliateAdmin(address affiliate) external view returns (address) {
		return AffiliateHubStorage.layout().affiliates[affiliate].admin;
	}

	function getAffiliateFeeDistributor(address affiliate) external view returns (address) {
		return AffiliateHubStorage.layout().affiliates[affiliate].feeDetails.feeDistributor;
	}

	function getAffiliateAccountManager(address affiliate) external view returns (address) {
		return AffiliateHubStorage.layout().affiliates[affiliate].accountManager;
	}

	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		EnumerableSet.AddressSet storage set = afLayout.affiliates[affiliate].symmioCores;
		uint256 len = set.length();

		address[] memory cores = new address[](len);
		for (uint256 i = 0; i < len; i++) {
			cores[i] = set.at(i);
		}
		return cores;
	}

	function getAffiliateStakeholders(address affiliate) external view returns (Stakeholder[] memory) {
		return AffiliateHubStorage.layout().affiliates[affiliate].feeDetails.stakeholders;
	}

	function getAffiliateSymmioShare(address affiliate) external view returns (uint256) {
		return AffiliateHubStorage.layout().affiliates[affiliate].feeDetails.symmioShare;
	}

	function isWhitelistedSymmioCore(address core) external view returns (bool) {
		return AffiliateHubStorage.layout().whitelistedSymmioCores[core];
	}

	function isLegacyMultiAccount(address account) external view returns (bool) {
		return AffiliateHubStorage.layout().legacyMultiAccounts.contains(account);
	}

	function getLegacyMultiAccounts() external view returns (address[] memory) {
		return AffiliateHubStorage.layout().legacyMultiAccounts.values();
	}

	function getLegacyAccountsOfUser(
		address owner,
		uint256 maxResults
	) external view returns (LegacyAccountInfo[] memory accounts, bool hasMore) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		address[] memory legacyContracts = afLayout.legacyMultiAccounts.values();

		// Count total accounts across all legacy contracts (number of legacy contracts is very limited)
		uint256 totalCount = 0;
		for (uint256 i = 0; i < legacyContracts.length; i++) {
			totalCount += IMultiAccount(legacyContracts[i]).getAccountsLength(owner);
		}

		if (totalCount == 0) {
			return (new LegacyAccountInfo[](0), false);
		}

		hasMore = totalCount > maxResults;
		uint256 resultSize = hasMore ? maxResults : totalCount;
		accounts = new LegacyAccountInfo[](resultSize);

		uint256 filled = 0;
		for (uint256 i = 0; i < legacyContracts.length && filled < resultSize; i++) {
			IMultiAccount multiAccount = IMultiAccount(legacyContracts[i]);
			uint256 count = multiAccount.getAccountsLength(owner);

			if (count == 0) continue;

			uint256 toFetch = count > (resultSize - filled) ? (resultSize - filled) : count;
			IMultiAccount.Account[] memory batch = multiAccount.getAccounts(owner, 0, toFetch);

			for (uint256 j = 0; j < batch.length && filled < resultSize; j++) {
				accounts[filled] = LegacyAccountInfo({
					accountAddress: batch[j].accountAddress,
					name: batch[j].name,
					legacyContract: legacyContracts[i],
					alreadyImported: ahLayout.subAccounts[batch[j].accountAddress].isExists
				});
				filled++;
			}
		}
	}

	function getHook(address affiliate, bytes4 selector) external view returns (address) {
		return AffiliateHubStorage.layout().affiliates[affiliate].hooks[selector];
	}

	function isOperator(address affiliate, bytes4 selector, address operator) external view returns (bool) {
		return AffiliateHubStorage.layout().operators[affiliate][selector][operator];
	}

	function symmioFeeReceiver() external view returns (address) {
		return AffiliateHubStorage.layout().symmioFeeReceiver;
	}

	function dryClaimAllFees(address affiliate, address symmio) external view returns (address[] memory holders, uint256[] memory shares) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		uint256 totalClaimable = LibAccountLayerUtils.getClaimableFee(affiliate, symmio);
		Stakeholder[] memory stakeholders = afLayout.affiliates[affiliate].feeDetails.stakeholders;

		uint256 len = stakeholders.length;
		holders = new address[](len);
		shares = new uint256[](len);

		for (uint256 i = 0; i < len; i++) {
			holders[i] = stakeholders[i].receiver;
			shares[i] = (stakeholders[i].share * totalClaimable) / SHARE_PRECISION;
		}

		return (holders, shares);
	}

	// ==================== Role Management ====================

	function hasRole(address user, bytes32 role) external view returns (bool) {
		return LibAccountLayerAccessibility.hasRole(user, role);
	}

	function isRoleAdmin(address user, bytes32 role) external view returns (bool) {
		return LibAccountLayerAccessibility.isRoleAdmin(user, role);
	}

	// ==================== Pause Control ====================

	function paused() external view returns (bool) {
		return AccountLayerStorage.layout().globalPaused;
	}

	// ==================== Constants ====================

	function MAX_NAME_LENGTH() external pure returns (uint256) {
		return LibAccountLayerUtils.MAX_NAME_LENGTH;
	}
}
