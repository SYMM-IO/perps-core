// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountHubLens } from "./interfaces/IAccountHubLens.sol";
import { IAccountHubInternal } from "./interfaces/IAccountHubInternal.sol";
import { IAccountHub } from "./interfaces/IAccountHub.sol";

/**
 * @title AccountHubLens
 * @notice Read-only contract for querying AccountHub data
 * @dev Implements the Lens pattern to reduce AccountHub contract size
 */
contract AccountHubLens is IAccountHubLens {
	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	IAccountHubInternal public immutable accountHub;

	constructor(address _accountHub) {
		accountHub = IAccountHubInternal(_accountHub);
	}

	// ==================== Sub-Account View Functions ====================

	/**
	 * @notice Gets detailed information for a single sub-account
	 * @param account The sub-account address
	 * @return SubAccountDetail struct with account information
	 */
	function getSubAccount(address account) external view returns (IAccountHub.SubAccountDetail memory) {
		return accountHub.getSubAccountRaw(account);
	}

	/**
	 * @notice Gets paginated sub-account addresses for an owner
	 * @param owner The owner address
	 * @param offset The starting index
	 * @param limit The maximum number of accounts to return
	 * @return Array of sub-account addresses
	 */
	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory) {
		uint256 total = accountHub.getUserSubAccountsCount(owner);
		if (offset >= total) {
			return new address[](0);
		}
		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;
		address[] memory paginatedAddresses = new address[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			paginatedAddresses[i] = accountHub.getUserSubAccountAt(owner, offset + i);
		}
		return paginatedAddresses;
	}

	/**
	 * @notice Gets paginated detailed information for sub-accounts of an owner
	 * @param owner The owner address
	 * @param offset The starting index
	 * @param limit The maximum number of accounts to return
	 * @return details Array of SubAccountDetail structs
	 */
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (IAccountHub.SubAccountDetail[] memory details) {
		uint256 total = accountHub.getUserSubAccountsCount(owner);

		if (offset >= total) {
			return new IAccountHub.SubAccountDetail[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		details = new IAccountHub.SubAccountDetail[](resultSize);

		for (uint256 i = 0; i < resultSize; i++) {
			address accountAddr = accountHub.getUserSubAccountAt(owner, offset + i);
			details[i] = accountHub.getSubAccountRaw(accountAddr);
		}
	}

	/**
	 * @notice Gets the total count of sub-accounts for an owner
	 * @param owner The owner address
	 * @return The total number of sub-accounts
	 */
	function getSubAccountsCountOfUser(address owner) external view returns (uint256) {
		return accountHub.getUserSubAccountsCount(owner);
	}

	// ==================== Virtual Account View Functions ====================

	/**
	 * @notice Gets detailed information for a single virtual account
	 * @param account The virtual account address
	 * @return VirtualAccountDetail struct with account information
	 */
	function getVirtualAccount(address account) external view returns (IAccountHub.VirtualAccountDetail memory) {
		return accountHub.getVirtualAccountRaw(account);
	}

	/**
	 * @notice Gets paginated virtual account addresses for a sub-account
	 * @param subAccount The sub-account address
	 * @param offset The starting index
	 * @param limit The maximum number of accounts to return
	 * @return Array of virtual account addresses
	 */
	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory) {
		uint256 total = accountHub.getSubAccountVirtualAccountsCount(subAccount);

		if (offset >= total) {
			return new address[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		address[] memory paginatedAccounts = new address[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			paginatedAccounts[i] = accountHub.getSubAccountVirtualAccountAt(subAccount, offset + i);
		}
		return paginatedAccounts;
	}

	/**
	 * @notice Gets paginated detailed information for virtual accounts of a sub-account
	 * @param subAccount The sub-account address
	 * @param offset The starting index
	 * @param limit The maximum number of accounts to return
	 * @return details Array of VirtualAccountDetail structs
	 */
	function getVirtualAccountsOfSubAccount(
		address subAccount,
		uint256 offset,
		uint256 limit
	) external view returns (IAccountHub.VirtualAccountDetail[] memory details) {
		uint256 total = accountHub.getSubAccountVirtualAccountsCount(subAccount);

		if (offset >= total) {
			return new IAccountHub.VirtualAccountDetail[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		details = new IAccountHub.VirtualAccountDetail[](resultSize);

		for (uint256 i = 0; i < resultSize; i++) {
			address accountAddr = accountHub.getSubAccountVirtualAccountAt(subAccount, offset + i);
			details[i] = accountHub.getVirtualAccountRaw(accountAddr);
		}
	}

	/**
	 * @notice Gets paginated quote IDs for a virtual account
	 * @param account The account address
	 * @param offset The starting index
	 * @param limit The maximum number of quote IDs to return
	 * @return Array of quote IDs
	 */
	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
		uint256 total = accountHub.getVirtualAccountQuoteIdsCount(account);

		if (offset >= total) {
			return new uint256[](0);
		}

		uint256 remaining = total - offset;
		uint256 resultSize = remaining < limit ? remaining : limit;

		uint256[] memory paginatedQuoteIds = new uint256[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			paginatedQuoteIds[i] = accountHub.getVirtualAccountQuoteIdAt(account, offset + i);
		}
		return paginatedQuoteIds;
	}

	/**
	 * @notice Gets the total count of virtual accounts for a sub-account
	 * @param subAccount The sub-account address
	 * @return The total number of virtual accounts
	 */
	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256) {
		return accountHub.getSubAccountVirtualAccountsCount(subAccount);
	}

	// ==================== Single VA Mode ====================

	/**
	 * @notice Gets the active virtual account for a given key (subAccount, isolationType, symbolId)
	 * @dev Only relevant when singleVAMode is enabled for the sub-account
	 * @param subAccount The sub-account address
	 * @param isolationType The virtual account isolation type
	 * @param symbolId The symbol ID
	 * @return The active virtual account address, or address(0) if none exists
	 */
	function getActiveVAByKey(
		address subAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address) {
		return accountHub.getActiveVAByKeyRaw(subAccount, isolationType, symbolId);
	}

	// ==================== Nonce and Prediction ====================

	/**
	 * @notice Gets the current virtual account nonce for a sub-account
	 * @param subAccount The sub-account address
	 * @return The current nonce value for virtual account creation
	 */
	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256) {
		return accountHub.getSubAccountVirtualNonceRaw(subAccount);
	}

	/**
	 * @notice Predicts the address of the next virtual account that will be created for a sub-account
	 * @param subAccount The sub-account address
	 * @param isolationType The virtual account isolation type
	 * @param symbolId The symbol ID (0 for position isolation)
	 * @return The predicted address for the next virtual account (either reused or newly generated)
	 */
	function predictNextVirtualAccountAddress(
		address subAccount,
		IAccountHub.VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address) {
		// First check if a deleted virtual account exists for this combination
		uint256 poolLength = accountHub.getDeletedVirtualAccountsPoolLength(subAccount, isolationType, symbolId);
		if (poolLength > 0) {
			// Return the address that would be reused (last element in the stack)
			return accountHub.getDeletedVirtualAccountAt(subAccount, isolationType, symbolId, poolLength - 1);
		}

		// If singleVAMode is enabled, check if there's already an active VA for this key
		IAccountHub.SubAccountDetail memory subAccountData = accountHub.getSubAccountRaw(subAccount);
		if (subAccountData.singleVAMode) {
			address existingVA = accountHub.getActiveVAByKeyRaw(subAccount, isolationType, symbolId);
			if (existingVA != address(0)) {
				IAccountHub.VirtualAccountDetail memory vaData = accountHub.getVirtualAccountRaw(existingVA);
				if (vaData.isExists) {
					return existingVA;
				}
			}
		}

		// If no deleted account exists, generate and return a new virtual account address
		uint256 nextNonce = accountHub.getSubAccountVirtualNonceRaw(subAccount) + 1;
		return _generateVirtualAccountAddress(subAccount, nextNonce);
	}

	// ==================== AccountManager ====================

	/**
	 * @notice Generates the predicted AccountManager address for a registrant and name
	 * @param registrant The registrant address
	 * @param name The affiliate name
	 * @return The predicted AccountManager address
	 */
	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address) {
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, registrant, name));
		bytes memory accountManagerImpl = IAccountHub(address(accountHub)).accountManagerImplementation();
		bytes memory bytecode = abi.encodePacked(accountManagerImpl, abi.encode(address(accountHub)));
		bytes32 initCodeHash = keccak256(bytecode);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(accountHub), salt, initCodeHash)))));
	}

	// ==================== Internal Functions ====================

	/**
	 * @dev Generates deterministic virtual account address
	 */
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
}
