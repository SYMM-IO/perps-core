// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

interface IAffiliateHub {
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

	// Affiliate events
	event AffiliateRegistered(address indexed affiliate, string name);
	event AffiliateApproved(address indexed affiliate, address indexed feeDistributor);
	event AffiliateUpdated(address indexed affiliate, string name, string brandColor);
	event AffiliatePaused(address indexed affiliate);
	event AffiliateUnpaused(address indexed affiliate);
	event AffiliateDeactivated(address indexed affiliate);
	event StakeholdersUpdateRequested(address indexed affiliate);
	event StakeholdersUpdated(address indexed affiliate);
	event RegistrationCancelled(address indexed affiliate);
	event AdminTransferProposed(address indexed affiliate, address indexed newAdmin);
	event AdminTransferCompleted(address indexed affiliate, address indexed oldAdmin, address indexed newAdmin);
	event AdminTransferCancelled(address indexed affiliate);

	// Fee events
	event FeesDistributed(address indexed recipient, uint256 amount);
	event FeesClaimed(address indexed affiliate, address indexed symmio, uint256 amount);
	event FeeUpdateCancelled(address indexed affiliate);
	event SymmioFeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

	// Hook events
	event HookSet(address indexed affiliate, bytes4 indexed selector, address hook);
	event HookRemoved(address indexed affiliate, bytes4 indexed selector);

	event WhitelistedSymmioCoreSet(address indexed core, bool status);

	// Affiliate management
	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external returns (address affiliateAddress);
	function cancelRegistration(address affiliate) external;
	function approveAffiliate(address affiliate) external;
	function proposeAdminTransfer(address affiliate, address newAdmin) external;
	function acceptAdminTransfer(address affiliate) external;
	function cancelAdminTransfer(address affiliate) external;
	function updateAffiliateDetails(address affiliate, string memory name, string memory brandColor) external;
	function pauseAffiliate(address affiliate) external;
	function unpauseAffiliate(address affiliate) external;

	// Fee management
	function requestFeeUpdate(address affiliate, Stakeholder[] memory newStakeholders, uint256 newSymmioShare) external;
	function cancelFeeUpdate(address affiliate) external;
	function approveFeeUpdate(address affiliate) external;
	function claimAllFees(address affiliate, address symmio) external;
	function claimFees(address affiliate, address symmio, uint256 amount) external;
	function dryClaimAllFees(address affiliate, address symmio) external view returns (address[] memory holders, uint256[] memory shares);

	// Hook management
	function setHook(address affiliate, bytes4 selector, address hook) external;
	function removeHook(address affiliate, bytes4 selector) external;
	function getHook(address affiliate, bytes4 selector) external view returns (address);

	// View functions
	function getAffiliateState(address affiliate) external view returns (AffiliateState);
	function getAffiliateAdmin(address affiliate) external view returns (address);
	function getAffiliateFeeDistributor(address affiliate) external view returns (address);
	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory);
	function isWhitelistedSymmioCore(address core) external view returns (bool);
	function isLegacyMultiAccount(address account) external view returns (bool);
	function getLegacyMultiAccounts() external view returns (address[] memory);

	// Admin functions
	function setSymmioFeeReceiver(address receiver) external;
	function setAccountManagerImplementation(bytes memory implementation) external;
	function setWhitelistedSymmioCore(address core, bool status) external;

	// ==================== Custom Errors ====================
	error ZeroAddress();
	error InvalidShare();
	error SharesMustSumTo100();
	error AlreadyRegistered();
	error NotAdmin();
	error NotPending();
	error AffiliateNotActive();
	error EmptyArray();
	error NoWhitelistedSymmioCore();
	error DeploymentFailed();
	error NoPendingUpdate();
	error Unauthorized();
	error InvalidState();
	error InvalidNameLength();
}

