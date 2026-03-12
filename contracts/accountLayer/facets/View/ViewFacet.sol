// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IViewFacet } from "./IViewFacet.sol";
import {
	AccountStorage,
	SubAccountData,
	SubAccountDetail,
	VirtualAccountData,
	VirtualAccountDetail,
	VirtualAccountIsolationType,
	LegacyAccountInfo
} from "../../storages/AccountStorage.sol";
import { AccountLayerStorage } from "../../storages/AccountLayerStorage.sol";
import { AffiliateStorage, AffiliateState, Stakeholder } from "../../storages/AffiliateStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";

/// @notice Read-only facet providing view functions for accounts, affiliates, roles, and system state
contract ViewFacet is IViewFacet {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");
	uint256 private constant SHARE_PRECISION = 1e18;

	// ==================== Sub-Account View Functions ====================

	/// @notice Returns the full details of a sub-account
	/// @param account The sub-account address
	/// @return The sub-account detail struct
	function getSubAccount(address account) external view returns (SubAccountDetail memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns paginated sub-account addresses owned by a user
	/// @param owner The user address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	/// @return The sub-account addresses
	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns paginated sub-account details owned by a user
	/// @param owner The user address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	/// @return details The sub-account detail structs
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory details) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns the total number of sub-accounts owned by a user
	/// @param owner The user address
	/// @return The count of sub-accounts
	function getSubAccountsCountOfUser(address owner) external view returns (uint256) {
		return AccountStorage.layout().userToSubAccounts[owner].length();
	}

	// ==================== Virtual Account View Functions ====================

	/// @notice Returns the full details of a virtual account
	/// @param account The virtual account address
	/// @return The virtual account detail struct
	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns paginated virtual account addresses belonging to a sub-account
	/// @param subAccount The parent sub-account address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	/// @return The virtual account addresses
	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns paginated virtual account details belonging to a sub-account
	/// @param subAccount The parent sub-account address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	/// @return details The virtual account detail structs
	function getVirtualAccountsOfSubAccount(
		address subAccount,
		uint256 offset,
		uint256 limit
	) external view returns (VirtualAccountDetail[] memory details) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns paginated quote IDs tracked by a virtual account
	/// @param account The virtual account address
	/// @param offset The starting index
	/// @param limit The maximum number of results
	/// @return The quote IDs
	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
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

	/// @notice Returns the number of active virtual accounts under a sub-account
	/// @param subAccount The parent sub-account address
	/// @return The count of virtual accounts
	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256) {
		return AccountStorage.layout().subAccountToVirtualAccounts[subAccount].length();
	}

	// ==================== Single VA Mode ====================

	/// @notice Returns the currently active virtual account for a given isolation key (singleVAMode)
	/// @param subAccount The parent sub-account address
	/// @param isolationType The isolation type
	/// @param symbolId The symbol identifier
	/// @return The active virtual account address (address(0) if none)
	function getActiveVAByKey(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId) external view returns (address) {
		return AccountStorage.layout().activeVAByKey[subAccount][isolationType][symbolId];
	}

	// ==================== Nonce and Prediction ====================

	/// @notice Returns the current virtual account nonce for a sub-account
	/// @param subAccount The sub-account address
	/// @return The current nonce (next VA will use nonce + 1)
	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256) {
		return AccountStorage.layout().subAccountVirtualNonces[subAccount];
	}

	/// @notice Predicts the address of the next virtual account for a given isolation key
	/// @dev Mirrors CoreFacet order: singleVAMode active VA, then reuse pool, then next nonce
	/// @param subAccount The parent sub-account address
	/// @param isolationType The isolation type
	/// @param symbolId The symbol identifier
	/// @return The predicted virtual account address
	function predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

		// If singleVAMode is enabled, check if there's already an active VA for this key
		if (ahLayout.subAccounts[subAccount].singleVAMode) {
			address existingVA = ahLayout.activeVAByKey[subAccount][isolationType][symbolId];
			if (existingVA != address(0) && ahLayout.virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		// Then check if a deleted virtual account exists for this combination
		uint256 poolLength = ahLayout.deletedVirtualAccountsPool[subAccount][isolationType][symbolId].length;
		if (poolLength > 0) {
			return ahLayout.deletedVirtualAccountsPool[subAccount][isolationType][symbolId][poolLength - 1];
		}

		// If neither active nor reusable account exists, generate and return a new virtual account address
		uint256 nextNonce = ahLayout.subAccountVirtualNonces[subAccount] + 1;
		return LibAccountLayerUtils.generateVirtualAccountAddress(subAccount, nextNonce);
	}

	// ==================== AccountManager ====================

	/// @notice Computes the next deterministic AccountManager address for a registrant and affiliate name
	/// @param registrant The registrant address
	/// @param name The affiliate name
	/// @return The next deterministic AccountManager address
	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		uint256 nextRegistrationNonce = AffiliateStorage.layout().registrationNonces[registrant] + 1;
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, registrant, name, nextRegistrationNonce));
		bytes memory bytecode = abi.encodePacked(ahLayout.accountManagerImplementation, abi.encode(address(this)));
		bytes32 initCodeHash = keccak256(bytecode);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
	}

	// ==================== Signer and Core ====================

	/// @notice Returns the current effective signer (globalSigner if set, otherwise msg.sender)
	/// @return The signer address
	function getSigner() public view returns (address) {
		return LibAccountLayerUtils.getSigner();
	}

	/// @notice Returns the Symmio core address associated with an account
	/// @param account The sub-account, virtual account, or legacy account address
	/// @return The Symmio core diamond address
	function getRelatedCore(address account) public view returns (address) {
		return LibAccountLayerUtils.getRelatedCore(account);
	}

	/// @notice Resolves the owner of an account (sub-account, virtual account, or legacy)
	/// @param account The account address
	/// @return The owner address (address(0) if not found)
	function ownerOf(address account) external view returns (address) {
		return LibAccountLayerUtils.resolveAccountOwner(account);
	}

	/// @notice Returns the global nonce used for sub-account address generation
	/// @return The current global nonce
	function globalNonce() external view returns (uint256) {
		return AccountStorage.layout().globalNonce;
	}

	/// @notice Returns the current AccountManager proxy bytecode
	/// @return The implementation bytecode
	function accountManagerImplementation() external view returns (bytes memory) {
		return AccountStorage.layout().accountManagerImplementation;
	}

	// ==================== Affiliate View Functions ====================

	/// @notice Returns the registration state of an affiliate
	/// @param affiliate The affiliate address
	/// @return The affiliate state (NONE, PENDING, ACTIVE, or PAUSED)
	function getAffiliateState(address affiliate) external view returns (AffiliateState) {
		return AffiliateStorage.layout().affiliates[affiliate].state;
	}

	/// @notice Returns the admin address of an affiliate
	/// @param affiliate The affiliate address
	/// @return The admin address
	function getAffiliateAdmin(address affiliate) external view returns (address) {
		return AffiliateStorage.layout().affiliates[affiliate].admin;
	}

	/// @notice Returns the deterministic fee distributor address of an affiliate
	/// @param affiliate The affiliate address
	/// @return The fee distributor address
	function getAffiliateFeeDistributor(address affiliate) external view returns (address) {
		return AffiliateStorage.layout().affiliates[affiliate].feeDetails.feeDistributor;
	}

	/// @notice Returns the Symmio core addresses registered for an affiliate
	/// @param affiliate The affiliate address
	/// @return The array of Symmio core addresses
	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		EnumerableSet.AddressSet storage set = afLayout.affiliates[affiliate].symmioCores;
		uint256 len = set.length();

		address[] memory cores = new address[](len);
		for (uint256 i = 0; i < len; i++) {
			cores[i] = set.at(i);
		}
		return cores;
	}

	/// @notice Returns the fee stakeholders for an affiliate
	/// @param affiliate The affiliate address
	/// @return The array of stakeholders with their receiver addresses and shares
	function getAffiliateStakeholders(address affiliate) external view returns (Stakeholder[] memory) {
		return AffiliateStorage.layout().affiliates[affiliate].feeDetails.stakeholders;
	}

	/// @notice Returns the Symmio protocol's share of fees for an affiliate (fraction of 1e18)
	/// @param affiliate The affiliate address
	/// @return The Symmio share
	function getAffiliateSymmioShare(address affiliate) external view returns (uint256) {
		return AffiliateStorage.layout().affiliates[affiliate].feeDetails.symmioShare;
	}

	/// @notice Checks whether a Symmio core address is whitelisted
	/// @param core The Symmio core address
	/// @return Whether the core is whitelisted
	function isWhitelistedSymmioCore(address core) external view returns (bool) {
		return AffiliateStorage.layout().whitelistedSymmioCores[core];
	}

	/// @notice Checks whether an address is a registered legacy MultiAccount contract
	/// @param account The address to check
	/// @return Whether it is a legacy MultiAccount
	function isLegacyMultiAccount(address account) external view returns (bool) {
		return AffiliateStorage.layout().legacyMultiAccounts.contains(account);
	}

	/// @notice Returns all registered legacy MultiAccount contract addresses
	/// @return The array of legacy MultiAccount addresses
	function getLegacyMultiAccounts() external view returns (address[] memory) {
		return AffiliateStorage.layout().legacyMultiAccounts.values();
	}

	/// @notice Returns legacy accounts owned by a user across all registered legacy MultiAccount contracts
	/// @param owner The user address
	/// @param maxResults The maximum number of results to return
	/// @return accounts The legacy account info structs
	/// @return hasMore Whether there are more accounts beyond maxResults
	function getLegacyAccountsOfUser(address owner, uint256 maxResults) external view returns (LegacyAccountInfo[] memory accounts, bool hasMore) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

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

	/// @notice Returns the hook contract address for an affiliate's function selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector
	/// @return The hook contract address (address(0) if not set)
	function getHook(address affiliate, bytes4 selector) external view returns (address) {
		return AffiliateStorage.layout().affiliates[affiliate].hooks[selector];
	}

	/// @notice Checks whether an address is an authorized operator for an affiliate's function selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector
	/// @param operator The operator address to check
	/// @return Whether the operator is authorized
	function isOperator(address affiliate, bytes4 selector, address operator) external view returns (bool) {
		return AffiliateStorage.layout().operators[affiliate][selector][operator];
	}

	/// @notice Returns the address that receives Symmio's share of affiliate fees
	/// @return The fee receiver address
	function symmioFeeReceiver() external view returns (address) {
		return AffiliateStorage.layout().symmioFeeReceiver;
	}

	/// @notice Simulates claiming all fees and returns the distribution per stakeholder
	/// @param affiliate The affiliate address
	/// @param symmio The Symmio core to check fees on
	/// @return holders The stakeholder addresses
	/// @return shares The fee amounts each stakeholder would receive
	function dryClaimAllFees(address affiliate, address symmio) external view returns (address[] memory holders, uint256[] memory shares) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
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

	/// @notice Checks whether a user has a specific role
	/// @param user The user address
	/// @param role The role identifier
	/// @return Whether the user has the role
	function hasRole(address user, bytes32 role) external view returns (bool) {
		return LibAccountLayerAccessibility.hasRole(user, role);
	}

	/// @notice Checks whether a user is a role admin for a specific role
	/// @param user The user address
	/// @param role The role identifier
	/// @return Whether the user is a role admin
	function isRoleAdmin(address user, bytes32 role) external view returns (bool) {
		return LibAccountLayerAccessibility.isRoleAdmin(user, role);
	}

	// ==================== Pause Control ====================

	/// @notice Returns whether the AccountLayer diamond is paused
	/// @return Whether the system is paused
	function paused() external view returns (bool) {
		return AccountLayerStorage.layout().globalPaused;
	}

	// ==================== Constants ====================

	/// @notice Returns the maximum allowed length for account and affiliate names
	/// @return The maximum name length in bytes
	function MAX_NAME_LENGTH() external pure returns (uint256) {
		return LibAccountLayerUtils.MAX_NAME_LENGTH;
	}
}
