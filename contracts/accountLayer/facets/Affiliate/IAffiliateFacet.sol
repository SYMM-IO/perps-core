// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AffiliateRegistration, Stakeholder } from "../../storages/AffiliateHubStorage.sol";

interface IAffiliateFacetEvents {
	event AffiliateRegistered(address indexed affiliate, string name);
	event AffiliateApproved(address indexed affiliate, address indexed feeDistributor);
	event AffiliateUpdated(address indexed affiliate, string name, string brandColor);
	event AffiliatePaused(address indexed affiliate);
	event AffiliateUnpaused(address indexed affiliate);
	event StakeholdersUpdateRequested(address indexed affiliate);
	event StakeholdersUpdated(address indexed affiliate);
	event RegistrationCancelled(address indexed affiliate);
	event RegistrationRejected(address indexed affiliate, address indexed admin);
	event AdminTransferProposed(address indexed affiliate, address indexed newAdmin);
	event AdminTransferCompleted(address indexed affiliate, address indexed oldAdmin, address indexed newAdmin);
	event AdminTransferCancelled(address indexed affiliate);
	event FeesDistributed(address indexed recipient, uint256 amount);
	event FeesClaimed(address indexed affiliate, address indexed symmio, uint256 amount);
	event FeeUpdateCancelled(address indexed affiliate);
	event HookSet(address indexed affiliate, bytes4 indexed selector, address hook);
	event HookRemoved(address indexed affiliate, bytes4 indexed selector);
	event OperatorSet(address indexed affiliate, bytes4 indexed selector, address indexed operator, bool status);
}

interface IAffiliateFacet is IAffiliateFacetEvents {
	// ==================== Affiliate Registration ====================

	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external returns (address affiliateAddress);

	function cancelRegistration(address affiliate) external;

	function rejectRegistration(address affiliate) external;

	function approveAffiliate(address affiliate) external;

	// ==================== Affiliate Admin Management ====================

	function proposeAdminTransfer(address affiliate, address newAdmin) external;

	function acceptAdminTransfer(address affiliate) external;

	function cancelAdminTransfer(address affiliate) external;

	function updateAffiliateDetails(address affiliate, string memory name, string memory brandColor) external;

	function pauseAffiliate(address affiliate) external;

	function unpauseAffiliate(address affiliate) external;

	// ==================== Fee Management ====================

	function requestFeeUpdate(address affiliate, Stakeholder[] memory newStakeholders, uint256 newSymmioShare) external;

	function cancelFeeUpdate(address affiliate) external;

	function approveFeeUpdate(address affiliate) external;

	function claimAllFees(address affiliate, address symmio) external;

	function claimFees(address affiliate, address symmio, uint256 amount) external;

	// ==================== Hook Management ====================

	function setHook(address affiliate, bytes4 selector, address hook) external;

	function removeHook(address affiliate, bytes4 selector) external;

	// ==================== Operator Management ====================

	function setOperator(address affiliate, bytes4 selector, address operator, bool status) external;

	// ==================== Delegated Calls ====================

	function callAsAffiliate(address affiliate, address symmio, bytes calldata callData) external returns (bytes memory result);

	// ==================== Custom Errors ====================

	error ZeroAddress();
	error InvalidShare();
	error SharesMustSumTo100();
	error AlreadyRegistered();
	error NotAdmin();
	error NotPending();
	error AffiliateNotActive();
	error NoWhitelistedSymmioCore();
	error NoPendingUpdate();
	error Unauthorized();
	error InvalidState();
	error InvalidNameLength();
	error InvalidCallData();
	error SymmioCoreNotAllowed();
}
