// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Operation } from "../../InstantLayerTypes.sol";
import { IInstantLayerErrors } from "../../interfaces/IInstantLayerErrors.sol";
import { IInstantLayerEvents } from "../../interfaces/IInstantLayerEvents.sol";

/// @notice Administrative interface for role management and InstantLayer configuration
/// @dev Role functions keep the OpenZeppelin (role, account) argument order. The accessibility
///      library takes (user, role); the facet transposes at each call site.
interface IControlFacet is IInstantLayerEvents, IInstantLayerErrors {
	// ==================== Ownership ====================

	/// @notice Initiates a two-step ownership transfer to a new address
	/// @dev The diamond owner, not a role, is what DiamondCutFacet.diamondCut gates on, so this
	///      is the path that moves upgrade authority to a governance timelock.
	/// @param owner The address of the pending new owner
	function transferOwnership(address owner) external;

	/// @notice Cancels the pending ownership transfer
	function cancelOwnershipTransfer() external;

	/// @notice Completes the two-step ownership transfer. Must be called by the pending owner.
	function acceptOwnership() external;

	// ==================== Role Management ====================

	/// @notice Grants a role to an account
	/// @param role The role identifier to grant
	/// @param account The address to receive the role
	function grantRole(bytes32 role, address account) external;

	/// @notice Revokes a role from an account
	/// @param role The role identifier to revoke
	/// @param account The address to lose the role
	function revokeRole(bytes32 role, address account) external;

	/// @notice Gives up a role held by the caller
	/// @param role The role identifier to renounce
	/// @param account The role holder, which must be the caller
	function renounceRole(bytes32 role, address account) external;

	/// @notice Reports whether an account holds a role
	/// @param role The role identifier to check
	/// @param account The address to check
	function hasRole(bytes32 role, address account) external view returns (bool);

	/// @notice Adds or removes an address as a role admin for a specific role
	/// @param user The address to set as role admin
	/// @param role The role identifier to manage
	/// @param status Whether the user should be a role admin
	function setRoleAdmin(address user, bytes32 role, bool status) external;

	// ==================== Registration Management ====================

	/// @notice Registers multiple PartyB contracts and grants each of them OPERATOR_ROLE
	/// @param partyBs Addresses of the PartyB contracts to register
	function registerPartyBs(address[] calldata partyBs) external;

	/// @notice Removes a PartyB contract from the registry and revokes its OPERATOR_ROLE
	/// @param partyB Address of the PartyB contract to unregister
	function unregisterPartyB(address partyB) external;

	/// @notice Sets the AccountLayer contract address and moves the target whitelist entry to it
	/// @param _accountLayer Address of the AccountLayer contract
	function setAccountLayer(address _accountLayer) external;

	/// @notice Whitelists or removes whitelist for a target contract
	/// @param target Target contract address
	/// @param allowed True to whitelist, false to remove
	function setTargetWhitelist(address target, bool allowed) external;

	/// @notice Selects the native begin/end execution-context selectors
	/// @param enabled True for the native selectors, false for the historical setter sequence
	function setTransientContextEnabled(bool enabled) external;

	/// @notice Updates the global cooldown for delegation revocations
	/// @param newCooldown New cooldown in seconds, between 5 minutes and 30 days
	function setRevocationCooldown(uint256 newCooldown) external;

	// ==================== Template Management ====================

	/// @notice Creates a new operation template
	/// @param name Human-readable name for the template
	/// @param operations Array of operation configurations with injection points
	function addTemplate(string calldata name, Operation[] calldata operations) external;

	/// @notice Marks a template as using instant-open mode
	/// @param templateId ID of the template to configure
	/// @param mode True to enable instant-open mode for this template
	function setTemplateInstantOpenMode(uint256 templateId, bool mode) external;

	/// @notice Enables or disables a template
	/// @param templateId ID of the template to update
	/// @param active Whether the template should be active
	function setTemplateActive(uint256 templateId, bool active) external;
}
