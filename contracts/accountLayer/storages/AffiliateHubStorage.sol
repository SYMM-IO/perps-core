// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice Lifecycle state of an affiliate registration
enum AffiliateState {
	NONE,
	PENDING,
	ACTIVE,
	PAUSED
}

/// @notice A fee recipient with their share of the affiliate's fee split
struct Stakeholder {
	address receiver;
	uint256 share;
}

/// @notice Fee distribution configuration for an affiliate
struct FeeDetails {
	uint256 symmioShare;
	Stakeholder[] stakeholders;
	address feeDistributor;
}

/// @notice Full configuration and state for a registered affiliate
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
	uint256 expressRate;
	address virtualProvider;
}

/// @notice Input parameters for registering a new affiliate
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

/// @notice A pending fee configuration change awaiting approval
struct PendingFeeUpdate {
	bool exists;
	uint256 timestamp;
	uint256 symmioShare;
	Stakeholder[] stakeholders;
}

/// @notice Contextual information available to hooks during execution
struct HookContext {
	address account;
	address affiliate;
	address symmioCore;
	bool isActive;
}

/// @title AffiliateHubStorage
/// @notice Affiliate registration, fee splits, and hook management
/// @dev Replaces per-frontend MultiAccount deployments. Affiliates register via
///      requestToRegisterAffiliate (PENDING) and are activated by APPROVER_ROLE.
///      Fees accrue in a deterministic feeDistributor address and are split on-chain
///      between stakeholders and Symmio (shares must sum to 1e18).
library AffiliateHubStorage {
	bytes32 internal constant AFFILIATE_HUB_STORAGE_SLOT = keccak256("diamond.standard.storage.affiliatehub");

	struct Layout {
		/// @notice All registered affiliate configurations
		/// @dev Maps affiliate address (= AccountManager address) => full config.
		///      Affiliate address is deterministic: generateAccountManagerAddress(registrant, name).
		mapping(address => AffiliateData) affiliates;
		/// @notice Pending fee configuration changes awaiting approval
		/// @dev Fee updates are two-step: requestFeeUpdate (admin) → approveFeeUpdate (APPROVER_ROLE).
		///      Timestamp recorded for audit trail, no enforced delay.
		mapping(address => PendingFeeUpdate) pendingFeeUpdates;
		/// @notice Operator permissions per affiliate per function
		/// @dev Affiliates can authorize operators for specific functions via callAsAffiliate.
		///      Maps affiliate => selector => operator => allowed.
		mapping(address => mapping(bytes4 => mapping(address => bool))) operators;
		/// @notice Set of all legacy MultiAccount contracts
		/// @dev For backward compatibility. AccountHub.ownerOf() scans these for ownership.
		EnumerableSet.AddressSet legacyMultiAccounts;
		/// @notice Whitelisted Symmio core contracts
		/// @dev Affiliates can only operate on whitelisted cores. Prevents connection
		///      to unauthorized diamonds. Managed by SETTER_ROLE.
		mapping(address => bool) whitelistedSymmioCores;
		/// @notice Protocol address receiving Symmio's share of fees
		/// @dev When claimFees is called, symmioShare portion goes here.
		address symmioFeeReceiver;
		/// @notice Counter for deterministic fee distributor address generation
		/// @dev Each affiliate gets a unique fee distributor address via CREATE2.
		uint256 globalNonce;
		/// @notice Current context during hook execution
		/// @dev Set when entering a hook, cleared on exit. Hooks can read this to
		///      know which account/affiliate/core triggered them.
		HookContext hookContext;
		/// @notice Which selectors can trigger hooks per affiliate
		/// @dev Maps affiliate => selector => allowed. Hooks are external calls that
		///      can execute custom logic (mint NFT, issue cashback, etc.).
		mapping(address => mapping(bytes4 => bool)) hookAllowedSelectors;
		/// @notice Which selectors affiliates can call via callAsAffiliate
		/// @dev Maps affiliate => selector => allowed. callAsAffiliate executes with
		///      setSigner(affiliate) on the target Symmio core.
		mapping(address => mapping(bytes4 => bool)) callAllowedSelectors;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = AFFILIATE_HUB_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
