// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IControlFacet } from "./IControlFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { AffiliateStorage } from "../../storages/AffiliateStorage.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";

/// @notice Administrative facet for role management, pause control, and system configuration
contract ControlFacet is IControlFacet, AccountLayerAccessibility, AccountLayerPausable {
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	// ==================== Role Management ====================

	/// @notice Grants a role to a user
	/// @param user The address to receive the role
	/// @param role The role identifier to grant
	function grantRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		LibAccountLayerAccessibility.grantRole(user, role);
		emit RoleGranted(role, user, msg.sender);
	}

	/// @notice Revokes a role from a user
	/// @param user The address to lose the role
	/// @param role The role identifier to revoke
	function revokeRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		LibAccountLayerAccessibility.revokeRole(user, role);
		emit RoleRevoked(role, user, msg.sender);
	}

	/// @notice Adds or removes an address as a role admin for a specific role
	/// @param user The address to set as role admin
	/// @param role The role identifier to manage
	/// @param status Whether the user should be a role admin
	function setRoleAdmin(address user, bytes32 role, bool status) external onlyRole(LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE) {
		LibAccountLayerAccessibility.setRoleAdmin(user, role, status);
		emit RoleAdminSet(role, user, status, msg.sender);
	}

	// ==================== Pause Control ====================

	/// @notice Pauses the AccountLayer diamond, blocking all state-changing operations
	function pause() external onlyRole(LibAccountLayerAccessibility.PAUSER_ROLE) {
		_pause();
	}

	/// @notice Unpauses the AccountLayer diamond, restoring normal operations
	function unpause() external onlyRole(LibAccountLayerAccessibility.UNPAUSER_ROLE) {
		_unpause();
	}

	// ==================== Account Configuration ====================

	/// @notice Sets the bytecode used to deploy new AccountManager proxies for affiliates
	/// @param implementation The AccountManager proxy bytecode
	function setAccountManagerImplementation(bytes memory implementation) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		if (implementation.length == 0) revert EmptyArray();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		bytes memory oldImplementation = ahLayout.accountManagerImplementation;
		ahLayout.accountManagerImplementation = implementation;
		ahLayout.initAccountManagerCodeHash = keccak256(abi.encodePacked(implementation));

		emit AccountManagerImplementationUpdated(oldImplementation, implementation);
	}

	/// @notice Sets the global signer used to authorize protocol-level operations
	/// @param _signer The new signer address (address(0) to clear)
	function setSigner(address _signer) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		address oldSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = _signer;

		emit SignerUpdated(oldSigner, _signer);
	}

	// ==================== Affiliate Configuration ====================

	/// @notice Sets the address that receives Symmio's share of affiliate fees
	/// @param receiver The new fee receiver address
	function setSymmioFeeReceiver(address receiver) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		if (receiver == address(0)) revert ZeroAddress();

		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		address oldReceiver = afLayout.symmioFeeReceiver;
		afLayout.symmioFeeReceiver = receiver;

		emit SymmioFeeReceiverUpdated(oldReceiver, receiver);
	}

	/// @notice Adds or removes a Symmio core diamond from the whitelist
	/// @param core The Symmio core diamond address
	/// @param status Whether the core should be whitelisted
	function setWhitelistedSymmioCore(address core, bool status) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		AffiliateStorage.layout().whitelistedSymmioCores[core] = status;
		emit WhitelistedSymmioCoreSet(core, status);
	}

	/// @notice Configures which function selectors an affiliate's hooks are allowed to execute
	/// @param affiliate The affiliate address
	/// @param selectors The function selectors to configure
	/// @param allowed Whether the selectors should be allowed for hook execution
	function setHookAllowedSelectors(
		address affiliate,
		bytes4[] calldata selectors,
		bool allowed
	) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		for (uint256 i = 0; i < selectors.length; i++) {
			afLayout.hookAllowedSelectors[affiliate][selectors[i]] = allowed;
		}
		emit HookAllowedSelectorsSet(affiliate, selectors, allowed);
	}

	/// @notice Configures which function selectors an affiliate can invoke via callAsAffiliate
	/// @param affiliate The affiliate address
	/// @param selectors The function selectors to configure
	/// @param allowed Whether the selectors should be allowed for delegated calls
	function setCallAllowedSelectors(
		address affiliate,
		bytes4[] calldata selectors,
		bool allowed
	) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		for (uint256 i = 0; i < selectors.length; i++) {
			afLayout.callAllowedSelectors[affiliate][selectors[i]] = allowed;
		}
		emit CallAllowedSelectorsSet(affiliate, selectors, allowed);
	}
}
