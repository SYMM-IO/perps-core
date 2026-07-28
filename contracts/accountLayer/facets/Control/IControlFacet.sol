// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

/// @notice Events emitted by the ControlFacet
interface IControlFacetEvents {
	/// @notice Emitted when a role is granted to a user
	event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
	/// @notice Emitted when a role is revoked from a user
	event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
	/// @notice Emitted when a role admin is added or removed
	event RoleAdminSet(bytes32 indexed role, address indexed account, bool status, address indexed sender);
	/// @notice Emitted when the AccountManager proxy bytecode is updated
	event AccountManagerImplementationUpdated(bytes oldImplementation, bytes newImplementation);
	/// @notice Emitted when the global signer is changed
	event SignerUpdated(address oldSigner, address newSigner);
	/// @notice Emitted when the signer session's account scope is changed
	/// @param signer The signer the scope applies to
	/// @param scope Canonical sub-account the session is confined to, or address(0) when unconfined
	event SignerScopeUpdated(address indexed signer, address indexed scope);
	/// @notice Emitted when a legacy setSigner caller's storage adapter configuration changes.
	event LegacySignerAdapterUpdated(address indexed legacyRouter, bool enabled);
	/// @notice Emitted when the Symmio fee receiver address is changed
	event SymmioFeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
	/// @notice Emitted when a Symmio core diamond is added to or removed from the whitelist
	event WhitelistedSymmioCoreSet(address indexed core, bool status);
	/// @notice Emitted when an AccountManager contract is deployed for an affiliate
	event AccountManagerDeployed(address indexed affiliate, address indexed accountManager);
	/// @notice Emitted when hook-allowed selectors are configured for an affiliate
	event HookAllowedSelectorsSet(address indexed affiliate, bytes4[] selectors, bool allowed);
	/// @notice Emitted when call-allowed selectors are configured for an affiliate
	event CallAllowedSelectorsSet(address indexed affiliate, bytes4[] selectors, bool allowed);
	/// @notice Emitted when a Symmio core is added to an affiliate after registration
	event SymmioCoreAddedToAffiliate(address indexed affiliate, address indexed core);
}

/// @notice Administrative interface for role management, pause control, and system configuration
interface IControlFacet is IControlFacetEvents, IAccountLayerErrors {
	// ==================== Ownership ====================

	/// @notice Initiates a two-step ownership transfer to a new address
	/// @param owner The address of the pending new owner
	function transferOwnership(address owner) external;

	/// @notice Cancels the pending ownership transfer
	function cancelOwnershipTransfer() external;

	/// @notice Completes the two-step ownership transfer. Must be called by the pending owner.
	function acceptOwnership() external;

	// ==================== Role Management ====================

	/// @notice Grants a role to a user
	/// @param user The address to receive the role
	/// @param role The role identifier to grant
	function grantRole(address user, bytes32 role) external;

	/// @notice Revokes a role from a user
	/// @param user The address to lose the role
	/// @param role The role identifier to revoke
	function revokeRole(address user, bytes32 role) external;

	/// @notice Adds or removes an address as a role admin for a specific role
	/// @param user The address to set as role admin
	/// @param role The role identifier to manage
	/// @param status Whether the user should be a role admin
	function setRoleAdmin(address user, bytes32 role, bool status) external;

	// ==================== Pause Control ====================

	/// @notice Pauses the AccountLayer diamond
	function pause() external;

	/// @notice Unpauses the AccountLayer diamond
	function unpause() external;

	// ==================== Account Configuration ====================

	/// @notice Sets the bytecode used to deploy new AccountManager proxies
	/// @param implementation The AccountManager proxy bytecode
	function setAccountManagerImplementation(bytes memory implementation) external;

	/// @notice Sets the global signer for protocol-level operations.
	/// @dev Configured legacy routers may have this selector adapted to transient storage.
	/// @param _signer The new signer address
	function setSigner(address _signer) external;

	/// @notice Sets the global signer and confines the session to a single account family
	/// @param _signer The new signer address
	/// @param _scope Canonical sub-account to confine the session to (address(0) for unconfined)
	function setSignerScoped(address _signer, address _scope) external;

	/// @notice Installs the effective signer for this transaction, or clears it with zero.
	/// @dev Runtime command, called around each InstantLayer operation. It is rejected while a
	///      persistent signer is set, so the two mechanisms never overlap within a transaction.
	/// @param signerOrZero The new signer address, or address(0) to end the signer scope
	function setTransientSigner(address signerOrZero) external;

	/// @notice Installs the effective signer for this transaction, confined to one account family.
	/// @dev Transient counterpart of setSignerScoped, used when executing on behalf of a delegate.
	/// @param signerOrZero The new signer address, or address(0) to end the signer scope
	/// @param scope Canonical sub-account to confine the session to (address(0) for unconfined)
	function setTransientSignerScoped(address signerOrZero, address scope) external;

	/// @notice Configures a legacy router's setSigner calls to use transient storage.
	/// @dev One-time administration, not a runtime command: it selects how that router's calls
	///      are stored. It neither installs a signer nor authorizes the router.
	/// @param legacyRouter The router whose setSigner calls are adapted
	/// @param enabled True to back that router's calls with transient storage
	function setLegacySignerAdapter(address legacyRouter, bool enabled) external;

	/// @notice Reports the configured storage mechanism for a legacy setSigner caller.
	/// @dev This does not report whether the caller is currently executing.
	function legacySignerAdapterEnabled(address legacyRouter) external view returns (bool);

	// ==================== Affiliate Configuration ====================

	/// @notice Sets the address that receives Symmio's share of affiliate fees
	/// @param receiver The new fee receiver address
	function setSymmioFeeReceiver(address receiver) external;

	/// @notice Adds or removes a Symmio core diamond from the whitelist
	/// @param core The Symmio core diamond address
	/// @param status Whether the core should be whitelisted
	function setWhitelistedSymmioCore(address core, bool status) external;

	/// @notice Configures which selectors an affiliate's hooks can execute
	/// @param affiliate The affiliate address
	/// @param selectors The function selectors to configure
	/// @param allowed Whether the selectors should be allowed
	function setHookAllowedSelectors(address affiliate, bytes4[] calldata selectors, bool allowed) external;

	/// @notice Configures which selectors an affiliate can invoke via callAsAffiliate
	/// @param affiliate The affiliate address
	/// @param selectors The function selectors to configure
	/// @param allowed Whether the selectors should be allowed
	function setCallAllowedSelectors(address affiliate, bytes4[] calldata selectors, bool allowed) external;

	/// @notice Adds a Symmio core to an active affiliate and registers it on that core
	/// @param affiliate The affiliate address
	/// @param core The whitelisted Symmio core address to add
	function addSymmioCoreToAffiliate(address affiliate, address core) external;
}
