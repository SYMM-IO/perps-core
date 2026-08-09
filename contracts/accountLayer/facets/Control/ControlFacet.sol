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

/// @notice Administrative facet for role management, pause control, and system configuration
contract ControlFacet is IControlFacet, AccountLayerAccessibility, AccountLayerPausable {
	using EnumerableSet for EnumerableSet.AddressSet;

	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	// ==================== Ownership ====================

	/// @notice Initiates a two-step ownership transfer to a new address. The new owner must call acceptOwnership() to complete the transfer.
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
	/// @dev Always opens an unconfined session. Callers acting for a delegate must use
	///      setSignerScoped instead, so that clearing through this path can never leave a
	///      stale scope behind for the next caller.
	/// @param _signer The new signer address (address(0) to clear)
	function setSigner(address _signer) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		_setSigner(_signer, address(0));
	}

	/// @notice Sets the global signer and confines the session to a single account family
	/// @dev Ownership checks alone cannot separate an owner's sub-accounts from one another, so a
	///      caller executing on behalf of a delegate supplies the account family that delegation was
	///      granted over. onlyAccountOwner then rejects any call that strays outside it.
	/// @param _signer The new signer address (address(0) to clear)
	/// @param _scope Canonical sub-account to confine the session to (address(0) for an unconfined session)
	function setSignerScoped(address _signer, address _scope) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		_setSigner(_signer, _scope);
	}

	function _setSigner(address _signer, address _scope) private {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		address oldSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = _signer;
		ahLayout.scopedAccount = _scope;

		emit SignerUpdated(oldSigner, _signer);
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
