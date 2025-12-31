// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IViewFacet } from "./IViewFacet.sol";
import { AccountHubStorage, SubAccountData, SubAccountDetail, VirtualAccountData, VirtualAccountDetail, VirtualAccountIsolationType, SubAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage, AffiliateData, AffiliateState, Stakeholder } from "../../storages/AffiliateHubStorage.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { IMultiAccount } from "../../interfaces/IMultiAccount.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";

contract ViewFacet is IViewFacet {
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
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
		return _generateVirtualAccountAddress(subAccount, nextNonce);
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
		uint256 totalClaimable = _getClaimableFee(affiliate, symmio);
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

	// ==================== Internal Functions ====================

	function _generateVirtualAccountAddress(address parentAccount, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), parentAccount, keccak256(abi.encodePacked(nonce)), VIRTUAL_ACCOUNT_INIT_CODE_HASH))
					)
				)
			);
	}

	function _getClaimableFee(address affiliate, address symmio) private view returns (uint256) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		uint8 decimals = IERC20Metadata(ISymmio(symmio).getCollateral()).decimals();
		uint256 balance = ISymmio(symmio).balanceOf(afLayout.affiliates[affiliate].feeDetails.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	// ==================== Constants ====================
	function MAX_NAME_LENGTH() external pure returns (uint256) {
		return 100;
	}
}
