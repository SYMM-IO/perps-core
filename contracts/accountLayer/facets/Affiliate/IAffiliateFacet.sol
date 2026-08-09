// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AffiliateRegistration, Stakeholder } from "../../storages/AffiliateStorage.sol";
import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

/// @notice Events emitted by the AffiliateFacet
interface IAffiliateFacetEvents {
	/// @notice Emitted when a new affiliate registration is submitted
	event AffiliateRegistered(address indexed affiliate, string name);
	/// @notice Emitted when a pending affiliate is approved and activated
	event AffiliateApproved(address indexed affiliate, address indexed feeDistributor);
	/// @notice Emitted when an affiliate's display details are updated
	event AffiliateUpdated(address indexed affiliate, string name, string brandColor);
	/// @notice Emitted when an affiliate is paused
	event AffiliatePaused(address indexed affiliate);
	/// @notice Emitted when an affiliate is unpaused
	event AffiliateUnpaused(address indexed affiliate);
	/// @notice Emitted when a fee configuration update is requested
	event StakeholdersUpdateRequested(address indexed affiliate);
	/// @notice Emitted when a fee configuration update is approved and applied
	event StakeholdersUpdated(address indexed affiliate);
	/// @notice Emitted when a pending registration is cancelled by the affiliate admin
	event RegistrationCancelled(address indexed affiliate);
	/// @notice Emitted when a pending registration is rejected by the approver
	event RegistrationRejected(address indexed affiliate, address indexed admin);
	/// @notice Emitted when an admin transfer is proposed
	event AdminTransferProposed(address indexed affiliate, address indexed newAdmin);
	/// @notice Emitted when an admin transfer is accepted by the new admin
	event AdminTransferCompleted(address indexed affiliate, address indexed oldAdmin, address indexed newAdmin);
	/// @notice Emitted when a pending admin transfer is cancelled
	event AdminTransferCancelled(address indexed affiliate);
	/// @notice Emitted when fees are distributed to a stakeholder or Symmio fee receiver
	event FeesDistributed(address indexed recipient, uint256 amount);
	/// @notice Emitted when fees are claimed and distributed for an affiliate
	event FeesClaimed(address indexed affiliate, address indexed symmio, uint256 amount);
	/// @notice Emitted when a pending fee update is cancelled
	event FeeUpdateCancelled(address indexed affiliate);
	/// @notice Emitted when a hook contract is set for an affiliate's function selector
	event HookSet(address indexed affiliate, bytes4 indexed selector, address hook);
	/// @notice Emitted when a hook contract is removed for an affiliate's function selector
	event HookRemoved(address indexed affiliate, bytes4 indexed selector);
	/// @notice Emitted when an operator is authorized or deauthorized for an affiliate
	event OperatorSet(address indexed affiliate, bytes4 indexed selector, address indexed operator, bool status);
}

/// @notice Interface for affiliate registration, admin management, fee distribution, hooks, and operators
interface IAffiliateFacet is IAffiliateFacetEvents, IAccountLayerErrors {
	// ==================== Affiliate Registration ====================

	/// @notice Submits a registration request for a new affiliate
	/// @param reg The registration data
	/// @return affiliateAddress The deterministic affiliate address
	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external returns (address affiliateAddress);

	/// @notice Cancels a pending affiliate registration
	/// @param affiliate The affiliate address
	function cancelRegistration(address affiliate) external;

	/// @notice Rejects a pending affiliate registration
	/// @param affiliate The affiliate address
	function rejectRegistration(address affiliate) external;

	/// @notice Approves a pending affiliate and deploys its AccountManager
	/// @param affiliate The affiliate address
	function approveAffiliate(address affiliate) external;

	// ==================== Affiliate Admin Management ====================

	/// @notice Proposes transferring the affiliate admin role to a new address
	/// @param affiliate The affiliate address
	/// @param newAdmin The proposed new admin address
	function proposeAdminTransfer(address affiliate, address newAdmin) external;

	/// @notice Accepts a pending admin transfer
	/// @param affiliate The affiliate address
	function acceptAdminTransfer(address affiliate) external;

	/// @notice Cancels a pending admin transfer proposal
	/// @param affiliate The affiliate address
	function cancelAdminTransfer(address affiliate) external;

	/// @notice Updates the display name and brand color of an affiliate
	/// @param affiliate The affiliate address
	/// @param name The new name
	/// @param brandColor The new brand color
	function updateAffiliateDetails(address affiliate, string memory name, string memory brandColor) external;

	/// @notice Pauses an affiliate
	/// @param affiliate The affiliate address
	function pauseAffiliate(address affiliate) external;

	/// @notice Unpauses a previously paused affiliate
	/// @param affiliate The affiliate address
	function unpauseAffiliate(address affiliate) external;

	// ==================== Fee Management ====================

	/// @notice Requests a fee configuration update for an affiliate
	/// @param affiliate The affiliate address
	/// @param newStakeholders The proposed new stakeholder list
	/// @param newSymmioShare The proposed new Symmio share
	function requestFeeUpdate(address affiliate, Stakeholder[] memory newStakeholders, uint256 newSymmioShare) external;

	/// @notice Cancels a pending fee configuration update
	/// @param affiliate The affiliate address
	function cancelFeeUpdate(address affiliate) external;

	/// @notice Approves a pending fee configuration update
	/// @param affiliate The affiliate address
	function approveFeeUpdate(address affiliate) external;

	/// @notice Claims all accrued fees for an affiliate and distributes to stakeholders
	/// @param affiliate The affiliate address
	/// @param symmio The Symmio core to claim from
	function claimAllFees(address affiliate, address symmio) external;

	/// @notice Claims a specific amount of fees and distributes to stakeholders
	/// @param affiliate The affiliate address
	/// @param symmio The Symmio core to claim from
	/// @param amount The amount of fees to claim
	function claimFees(address affiliate, address symmio, uint256 amount) external;

	// ==================== Hook Management ====================

	/// @notice Sets a hook contract for a specific function selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector that triggers the hook
	/// @param hook The hook contract address
	function setHook(address affiliate, bytes4 selector, address hook) external;

	/// @notice Removes a hook contract for a specific function selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector to remove the hook for
	function removeHook(address affiliate, bytes4 selector) external;

	// ==================== Operator Management ====================

	/// @notice Grants or revokes operator permissions for a specific function selector
	/// @param affiliate The affiliate address
	/// @param selector The function selector
	/// @param operator The operator address
	/// @param status Whether the operator should be authorized
	function setOperator(address affiliate, bytes4 selector, address operator, bool status) external;

	// ==================== Delegated Calls ====================

	/// @notice Executes a whitelisted call on a Symmio core as the affiliate
	/// @param affiliate The affiliate address to act as
	/// @param symmio The Symmio core to call
	/// @param callData The encoded function call
	/// @return result The return data from the call
	function callAsAffiliate(address affiliate, address symmio, bytes calldata callData) external returns (bytes memory result);
}
