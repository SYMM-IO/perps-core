// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

enum VirtualAccountIsolationType {
	POSITION,
	MARKET,
	MARKET_LONG,
	MARKET_SHORT
}

enum SubAccountIsolationType {
	POSITION,
	MARKET,
	MARKET_DIRECTION,
	CUSTOM
}

struct SubAccountData {
	string name;
	address owner;
	bool isExists;
	bool singleVAMode;
	bytes metadata;
	address affiliate;
	address symmioCore;
	SubAccountIsolationType isolationType;
}

struct VirtualAccountData {
	bool isExists;
	bytes metadata;
	address parentAccount;
	uint256 symbolId;
	VirtualAccountIsolationType isolationType;
	EnumerableSet.UintSet quoteIds;
}

struct SubAccountCreationData {
	string name;
	bytes metadata;
	address symmioCore;
	SubAccountIsolationType isolationType;
	bool singleVAMode;
}

struct SubAccountDetail {
	address accountAddress;
	address owner;
	string name;
	bool isExists;
	bool singleVAMode;
	address affiliate;
	address symmioCore;
	bytes metadata;
	SubAccountIsolationType isolationType;
}

struct VirtualAccountDetail {
	address accountAddress;
	address parentAccount;
	uint256 symbolId;
	bool isExists;
	bytes metadata;
	VirtualAccountIsolationType isolationType;
}

struct LegacyAccountInfo {
	address accountAddress;
	string name;
	address legacyContract;
	bool alreadyImported;
}

struct LegacyAccountImportData {
	address account;
	string name;
	uint256 coreIndex;
}

library AccountHubStorage {
	bytes32 internal constant ACCOUNT_HUB_STORAGE_SLOT = keccak256("diamond.standard.storage.accounthub");

	struct Layout {
		// Sub-account data
		mapping(address => SubAccountData) subAccounts;
		mapping(address => EnumerableSet.AddressSet) userToSubAccounts;
		// Virtual account data
		mapping(address => VirtualAccountData) virtualAccounts;
		mapping(address => EnumerableSet.AddressSet) subAccountToVirtualAccounts;
		// Pool of deleted virtual accounts for reuse: parentAccount => isolationType => symbolId => stack of addresses
		mapping(address => mapping(VirtualAccountIsolationType => mapping(uint256 => address[]))) deletedVirtualAccountsPool;
		// Active virtual account by key (for singleVAMode): subAccount => isolationType => symbolId => VA address
		mapping(address => mapping(VirtualAccountIsolationType => mapping(uint256 => address))) activeVAByKey;
		// Nonces
		uint256 globalNonce;
		mapping(address => uint256) subAccountVirtualNonces;
		// Configuration
		address globalSigner;
		bytes accountManagerImplementation;
		bytes32 initAccountManagerCodeHash;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = ACCOUNT_HUB_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
