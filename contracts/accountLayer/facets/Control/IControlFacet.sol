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
}

/// @notice Administrative interface for role management, pause control, and system configuration
interface IControlFacet is IControlFacetEvents, IAccountLayerErrors {
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

	// ==================== AccountHub Configuration ====================

	/// @notice Sets the bytecode used to deploy new AccountManager proxies
	/// @param implementation The AccountManager proxy bytecode
	function setAccountManagerImplementation(bytes memory implementation) external;

	/// @notice Sets the global signer for protocol-level operations
	/// @param _signer The new signer address
	function setSigner(address _signer) external;

	// ==================== AffiliateHub Configuration ====================

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
}
