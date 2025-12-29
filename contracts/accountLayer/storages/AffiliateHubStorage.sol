// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

enum AffiliateState {
	NONE,
	PENDING,
	ACTIVE,
	PAUSED,
	DEACTIVATED
}

struct Stakeholder {
	address receiver;
	uint256 share; // in 18 decimals, must sum to 100% - symmioShare
}

struct FeeDetails {
	uint256 symmioShare;
	Stakeholder[] stakeholders;
	address feeDistributor;
}

struct AffiliateData {
	string name;
	string brandColor;
	address admin;
	address pendingAdmin;
	AffiliateState state;
	FeeDetails feeDetails;
	bytes metadata;
	address[] legacyMultiAccounts;
	EnumerableSet.AddressSet symmioCores;
	mapping(bytes4 => address) hooks;
	address accountManager;
	address registrant;
}

struct AffiliateRegistration {
	string name;
	string brandColor;
	address admin;
	Stakeholder[] stakeholders;
	uint256 symmioShare;
	bytes metadata;
	address[] legacyMultiAccounts;
	address[] symmioCores;
}

struct PendingFeeUpdate {
	bool exists;
	uint256 timestamp;
	uint256 symmioShare;
	Stakeholder[] stakeholders;
}

library AffiliateHubStorage {
	bytes32 internal constant AFFILIATE_HUB_STORAGE_SLOT = keccak256("diamond.standard.storage.affiliatehub");

	struct Layout {
		// Affiliate registry
		mapping(address => AffiliateData) affiliates;
		mapping(address => PendingFeeUpdate) pendingFeeUpdates;
		// Operators: affiliate => selector => operator => allowed
		mapping(address => mapping(bytes4 => mapping(address => bool))) operators;
		// Legacy multi-accounts
		EnumerableSet.AddressSet legacyMultiAccounts;
		// Whitelisted Symmio cores
		mapping(address => bool) whitelistedSymmioCores;
		// Fee configuration
		address symmioFeeReceiver;
		// Nonce for fee distributor address generation
		uint256 globalNonce;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = AFFILIATE_HUB_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
