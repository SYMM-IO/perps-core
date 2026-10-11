// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Operation, Template } from "../../InstantLayerTypes.sol";
import { IControlFacet } from "./IControlFacet.sol";
import { InstantLayerAccessibility } from "../../utils/InstantLayerAccessibility.sol";
import { InstantLayerStorage } from "../../storages/InstantLayerStorage.sol";
import { TemplateStorage } from "../../storages/TemplateStorage.sol";
import { LibInstantLayerAccessibility } from "../../libraries/LibInstantLayerAccessibility.sol";
import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";

/// @notice Administrative facet for role management and InstantLayer configuration
/// @dev The role externals take (role, account); LibInstantLayerAccessibility takes
///      (user, role). Every call below transposes, so read each one against the library
///      signature rather than against the external it sits in.
contract ControlFacet is IControlFacet, InstantLayerAccessibility {
	// ==================== Ownership ====================

	/// @notice Initiates a two-step ownership transfer to a new address. The new owner must call acceptOwnership() to complete the transfer.
	/// @dev Upgrade authority sits with the diamond owner rather than a role, because
	///      DiamondCutFacet.diamondCut gates on LibDiamond.enforceIsContractOwner(). This is the
	///      path that hands that authority to a governance timelock.
	/// @param owner The address of the pending new owner.
	function transferOwnership(address owner) external {
		LibDiamond.enforceIsContractOwner();
		LibDiamond.transferOwnership(owner);
	}

	/// @notice Cancels the pending ownership transfer.
	function cancelOwnershipTransfer() external {
		LibDiamond.enforceIsContractOwner();
		LibDiamond.cancelOwnershipTransfer();
	}

	/// @notice Completes the two-step ownership transfer. Must be called by the pending owner set via transferOwnership().
	function acceptOwnership() external {
		LibDiamond.acceptOwnership();
	}

	// ==================== Role Management ====================

	/// @notice Grants a role to an account
	/// @param role The role identifier to grant
	/// @param account The address to receive the role
	function grantRole(bytes32 role, address account) external onlyRoleAdmin(role) {
		LibInstantLayerAccessibility.grantRole(account, role);
		emit RoleGranted(role, account, msg.sender);
	}

	/// @notice Revokes a role from an account
	/// @param role The role identifier to revoke
	/// @param account The address to lose the role
	function revokeRole(bytes32 role, address account) external onlyRoleAdmin(role) {
		LibInstantLayerAccessibility.revokeRole(account, role);
		emit RoleRevoked(role, account, msg.sender);
	}

	/// @notice Gives up a role held by the caller
	/// @dev Matches the OpenZeppelin semantic: a caller may only renounce for itself.
	/// @param role The role identifier to renounce
	/// @param account The role holder, which must be the caller
	function renounceRole(bytes32 role, address account) external {
		if (account != msg.sender) revert CanOnlyRenounceForSelf();
		LibInstantLayerAccessibility.revokeRole(account, role);
		emit RoleRevoked(role, account, msg.sender);
	}

	/// @notice Reports whether an account holds a role
	/// @param role The role identifier to check
	/// @param account The address to check
	function hasRole(bytes32 role, address account) external view returns (bool) {
		return LibInstantLayerAccessibility.hasRole(account, role);
	}

	/// @notice Adds or removes an address as a role admin for a specific role
	/// @param user The address to set as role admin
	/// @param role The role identifier to manage
	/// @param status Whether the user should be a role admin
	function setRoleAdmin(address user, bytes32 role, bool status) external onlyRole(LibInstantLayerAccessibility.DEFAULT_ADMIN_ROLE) {
		LibInstantLayerAccessibility.setRoleAdmin(user, role, status);
		emit RoleAdminSet(role, user, status, msg.sender);
	}

	// ==================== Registration Management ====================

	/// @notice Registers multiple PartyB contracts and grants each of them OPERATOR_ROLE
	/// @param partyBs Addresses of the PartyB contracts to register
	function registerPartyBs(address[] calldata partyBs) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		if (partyBs.length == 0) revert EmptyArray();
		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();
		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];
			if (l.registeredPartyBs[partyB]) revert PartyBAlreadyRegistered(partyB);
			l.registeredPartyBs[partyB] = true;
			LibInstantLayerAccessibility.grantRole(partyB, LibInstantLayerAccessibility.OPERATOR_ROLE);
			emit RoleGranted(LibInstantLayerAccessibility.OPERATOR_ROLE, partyB, msg.sender);
			emit PartyBRegistered(partyB);
		}
	}

	/// @notice Removes a PartyB contract from the registry and revokes its OPERATOR_ROLE
	/// @param partyB Address of the PartyB contract to unregister
	function unregisterPartyB(address partyB) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();
		if (!l.registeredPartyBs[partyB]) revert PartyBNotRegistered(partyB);
		l.registeredPartyBs[partyB] = false;
		LibInstantLayerAccessibility.revokeRole(partyB, LibInstantLayerAccessibility.OPERATOR_ROLE);
		emit RoleRevoked(LibInstantLayerAccessibility.OPERATOR_ROLE, partyB, msg.sender);
		emit PartyBUnregistered(partyB);
	}

	/// @notice Sets the AccountLayer contract address and moves the target whitelist entry to it
	/// @param _accountLayer Address of the AccountLayer contract
	function setAccountLayer(address _accountLayer) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		if (_accountLayer == address(0)) revert UnregisteredAccountLayer(_accountLayer);
		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();
		address oldAccountLayer = l.accountLayer;
		l.whitelistedTargets[oldAccountLayer] = false;
		l.accountLayer = _accountLayer;
		l.whitelistedTargets[_accountLayer] = true;
		emit AccountLayerUpdated(oldAccountLayer, _accountLayer);
		emit TargetWhitelistUpdated(_accountLayer, true);
	}

	/// @notice Whitelists or removes whitelist for a target contract
	/// @param target Target contract address
	/// @param allowed True to whitelist, false to remove
	function setTargetWhitelist(address target, bool allowed) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		if (target == address(0)) revert InvalidCallData();
		InstantLayerStorage.layout().whitelistedTargets[target] = allowed;
		emit TargetWhitelistUpdated(target, allowed);
	}

	/// @notice Selects the native begin/end execution-context selectors
	/// @dev Disabling selects the historical mode and signer setters. Both selector routes
	///      write transient storage in this build; this is not a persistent-storage rollback.
	///      The switch does not alter signed data or templates.
	/// @param enabled True for the native selectors, false for the historical setter sequence
	function setTransientContextEnabled(bool enabled) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		InstantLayerStorage.layout().transientContextEnabled = enabled;
		emit TransientContextEnabledUpdated(enabled);
	}

	/// @notice Updates the global cooldown for delegation revocations
	/// @param newCooldown New cooldown in seconds, between 5 minutes and 30 days
	function setRevocationCooldown(uint256 newCooldown) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		// Zero is disallowed to keep the two-step invariant.
		if (newCooldown < 5 minutes || newCooldown > 30 days) revert InvalidCallData();
		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();
		uint256 oldCooldown = l.revocationCooldown;
		l.revocationCooldown = newCooldown;
		emit RevocationCooldownUpdated(oldCooldown, newCooldown);
	}

	// ==================== Template Management ====================

	/// @notice Creates a new operation template
	/// @param name Human-readable name for the template
	/// @param operations Array of operation configurations with injection points
	function addTemplate(
		string calldata name,
		Operation[] calldata operations
	) external onlyRole(LibInstantLayerAccessibility.TEMPLATE_MANAGER_ROLE) {
		if (operations.length == 0) revert EmptyTemplate();

		TemplateStorage.Layout storage l = TemplateStorage.layout();
		uint256 templateId = l.nextTemplateId++;
		Template storage template = l.templates[templateId];
		template.name = name;
		template.active = true;

		for (uint256 i = 0; i < operations.length; i++) {
			template.operations.push(operations[i]);
		}

		emit TemplateAdded(templateId, name);
	}

	/// @notice Marks a template as using instant-open mode
	/// @param templateId ID of the template to configure
	/// @param mode True to enable instant-open mode for this template
	function setTemplateInstantOpenMode(uint256 templateId, bool mode) external onlyRole(LibInstantLayerAccessibility.SETTER_ROLE) {
		TemplateStorage.Layout storage l = TemplateStorage.layout();
		if (templateId >= l.nextTemplateId) revert InvalidTemplate(templateId);
		l.templateInstantOpenMode[templateId] = mode;
	}

	/// @notice Enables or disables a template
	/// @param templateId ID of the template to update
	/// @param active Whether the template should be active
	function setTemplateActive(uint256 templateId, bool active) external onlyRole(LibInstantLayerAccessibility.TEMPLATE_MANAGER_ROLE) {
		TemplateStorage.Layout storage l = TemplateStorage.layout();
		if (templateId >= l.nextTemplateId) revert InvalidTemplate(templateId);
		l.templates[templateId].active = active;
		emit TemplateUpdated(templateId, active);
	}
}
