// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IControlFacet } from "./IControlFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { AffiliateStorage, AffiliateState } from "../../storages/AffiliateStorage.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";
import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { LibAccountLayerSigner } from "../../libraries/LibAccountLayerSigner.sol";

/// @notice Administrative facet for role management, pause control, and system configuration
contract ControlFacet is IControlFacet, AccountLayerAccessibility, AccountLayerPausable {
	using EnumerableSet for EnumerableSet.AddressSet;

	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	// ==================== Ownership ====================

	/// @notice Initiates a two-step ownership transfer to a new address. The new owner must call acceptOwnership() to complete the transfer.
	/// @param owner The address of the pending new owner.
	function transferOwnership(address owner) external {
		LibDiamond.enforceIsContractOwner();
		if (owner == address(0)) revert ZeroAddress();
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

	/// @notice Grants DEFAULT_ADMIN_ROLE to a user.
	/// @dev Only the diamond owner may appoint a default admin.
	function setAdmin(address user) external {
		LibDiamond.enforceIsContractOwner();
		if (user == address(0)) revert ZeroAddress();
		LibAccountLayerAccessibility.grantRole(user, LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE);
		emit RoleGranted(LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE, user, msg.sender);
	}

	/// @notice Grants a role to a user
	/// @param user The address to receive the role
	/// @param role The role identifier to grant
	function grantRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		if (user == address(0)) revert ZeroAddress();
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

	/// @notice Appoints an admin that may grant or revoke one role.
	function addRoleAdmin(bytes32 role, address admin) external onlyRole(LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE) {
		if (admin == address(0)) revert ZeroAddress();
		LibAccountLayerAccessibility.setRoleAdmin(admin, role, true);
		emit RoleAdminAdded(role, admin);
	}

	/// @notice Removes an admin for one role.
	function removeRoleAdmin(bytes32 role, address admin) external onlyRole(LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE) {
		if (admin == address(0)) revert ZeroAddress();
		LibAccountLayerAccessibility.setRoleAdmin(admin, role, false);
		emit RoleAdminRemoved(role, admin);
	}

	/// @notice Adds or removes an address as a role admin for a specific role
	/// @dev Compatibility adapter for integrations that use the original AccountLayer selector.
	/// @param user The address to set as role admin
	/// @param role The role identifier to manage
	/// @param status Whether the user should be a role admin
	function setRoleAdmin(address user, bytes32 role, bool status) external onlyRole(LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE) {
		if (user == address(0)) revert ZeroAddress();
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

	/// @notice Sets the global signer used to authorize protocol-level operations.
	/// @dev Deployed routers keep this selector and its calldata, but internally it installs and
	///      clears the same transient signer scope that setTransientSigner uses. Both the legacy
	///      set/clear pair and the explicit call are therefore behaviourally identical.
	///      This matters beyond InstantLayer: AffiliateFacet grants SIGNER_SETTER_ROLE to every
	///      AccountManager it deploys, so the set of legacy callers grows at runtime and cannot be
	///      enumerated. Routing unconditionally keeps them all on one mechanism.
	///      Always opens an unconfined session; callers acting for a delegate must use
	///      setSignerScoped instead, so clearing through this path can never leave a stale scope
	///      behind for the next caller.
	/// @param _signer The new signer address (address(0) to clear)
	function setSigner(address _signer) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		_installTransientSigner(_signer, address(0));
	}

	/// @notice Sets the global signer and confines the session to a single account family
	/// @dev Ownership checks alone cannot separate an owner's sub-accounts from one another, so a
	///      caller executing on behalf of a delegate supplies the account family that delegation was
	///      granted over. onlyAccountOwner then rejects any call that strays outside it.
	///      Routed to the same transient mechanism as setSigner.
	/// @param _signer The new signer address (address(0) to clear)
	/// @param _scope Canonical sub-account to confine the session to (address(0) for an unconfined session)
	function setSignerScoped(address _signer, address _scope) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		_installTransientSigner(_signer, _scope);
	}

	// ==================== Transaction Signer Runtime ====================

	/// @notice Installs the effective signer for the current transaction, or clears it with zero.
	/// @dev Always opens an unconfined session; clearing through this path also clears any scope.
	function setTransientSigner(address signerOrZero) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		_installTransientSigner(signerOrZero, address(0));
	}

	/// @notice Installs the effective signer for the current transaction, confined to one account family.
	/// @dev Transient counterpart of setSignerScoped: a router executing on behalf of a delegate
	///      supplies the account family the delegation was granted over, and onlyAccountOwner
	///      rejects anything outside it for the rest of the transient session.
	/// @param signerOrZero The new signer address, or address(0) to end the signer scope
	/// @param scope Canonical sub-account to confine the session to (address(0) for an unconfined session)
	function setTransientSignerScoped(address signerOrZero, address scope) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		_installTransientSigner(signerOrZero, scope);
	}

	/// @dev Single install path for all four signer selectors, so scope and signer can never
	///      diverge across them.
	function _installTransientSigner(address _signer, address _scope) private {
		require(AccountStorage.layout().globalSigner == address(0), "ControlFacet: Persistent signer is set");
		address previousSigner = LibAccountLayerSigner.configuredSigner();
		// Fail closed rather than silently taking over a live scope. A nested legacy caller --
		// an AccountManager reached from inside an InstantLayer batch, say -- must not overwrite
		// the outer router's signer and then clear it on the way out. This mirrors the guard the
		// persistent branch used to carry, and the one core's setSigner still has.
		if (_signer != address(0)) require(previousSigner == address(0), "ControlFacet: Transient signer is set");
		LibAccountLayerSigner.setTransientSignerScoped(_signer, _scope);
		emit SignerUpdated(previousSigner, _signer);
		emit SignerScopeUpdated(_signer, _scope);
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

	/// @notice Adds a Symmio core to an active affiliate and registers it on that core
	/// @param affiliate The affiliate address
	/// @param core The whitelisted Symmio core address to add
	function addSymmioCoreToAffiliate(address affiliate, address core) external onlyRole(LibAccountLayerAccessibility.APPROVER_ROLE) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.ACTIVE) revert InvalidState();
		if (!afLayout.whitelistedSymmioCores[core]) revert NoWhitelistedSymmioCore();
		if (!afLayout.affiliates[affiliate].symmioCores.add(core)) revert AlreadyRegistered();

		ISymmio(core).registerAffiliate(affiliate);
		ISymmio(core).setFeeCollector(affiliate, afLayout.affiliates[affiliate].feeDetails.feeDistributor);

		emit SymmioCoreAddedToAffiliate(affiliate, core);
	}
}
