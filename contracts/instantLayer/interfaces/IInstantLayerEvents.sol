// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Role, configuration, and template events for the InstantLayer diamond.
/// @dev Init and ControlFacet both write the same state, so both inherit these declarations
///      rather than each carrying its own copy.
interface IInstantLayerEvents {
	/// @notice Emitted when a role is granted to an account
	/// @dev Shape matches OpenZeppelin AccessControl so existing indexers keep decoding it.
	///      With getRoleMember and getRoleMemberCount absent from this diamond, these logs are
	///      the only off-chain route to the set of role holders, so every grant emits one,
	///      including the genesis grants in Init.
	event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);

	/// @notice Emitted when a role is revoked from an account
	event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

	/// @notice Emitted when a role admin is added or removed
	event RoleAdminSet(bytes32 indexed role, address indexed account, bool status, address indexed sender);

	/// @notice Emitted when a new template is created
	/// @param templateId Unique identifier assigned to the template
	/// @param name Human-readable name of the template
	event TemplateAdded(uint256 indexed templateId, string name);

	/// @notice Emitted when a template's active status changes
	/// @param templateId Template that was modified
	/// @param active New active status of the template
	event TemplateUpdated(uint256 indexed templateId, bool active);

	/// @notice Emitted when a PartyB contract is registered
	/// @param partyB Address of the newly registered PartyB
	event PartyBRegistered(address indexed partyB);

	/// @notice Emitted when a PartyB contract is removed from registry
	/// @param partyB Address of the unregistered PartyB
	event PartyBUnregistered(address indexed partyB);

	/// @notice Emitted when the configured AccountLayer is updated
	/// @param oldAccountLayer old AccountLayer
	/// @param newAccountLayer new AccountLayer
	event AccountLayerUpdated(address indexed oldAccountLayer, address indexed newAccountLayer);

	/// @notice Emitted when target whitelist status changes
	/// @param target Target contract address
	/// @param allowed Whether the target is whitelisted
	event TargetWhitelistUpdated(address indexed target, bool allowed);

	/// @notice Emitted when the revocation cooldown is updated
	/// @param oldCooldown The old cooldown period
	/// @param newCooldown The new cooldown period
	event RevocationCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

	/// @notice Emitted when transient execution is enabled or disabled.
	event TransientContextEnabledUpdated(bool enabled);

	/// @notice Emitted when delegation permission is granted
	/// @param delegator Address granting the delegation
	/// @param delegate Address receiving delegation permission
	/// @param selector Function selector being delegated
	/// @param expiryTimestamp When the delegation expires
	event DelegationGranted(address indexed delegator, address indexed delegate, bytes4 selector, uint256 expiryTimestamp);

	/// @notice Emitted when a delegation nonce is incremented
	/// @param delegator Address whose delegation nonce was incremented
	/// @param newNonce The new delegation nonce value
	event DelegationNonceIncremented(address indexed delegator, uint256 newNonce);

	/// @notice Emitted when a delegation selector is scheduled for revocation
	/// @param delegator Address whose delegation is being revoked
	/// @param delegate Address whose delegation is being revoked
	/// @param selector Function selector being revoked
	/// @param eta The eta at which the revocation will take effect
	event RevocationScheduled(address indexed delegator, address indexed delegate, bytes4 selector, uint256 eta);

	/// @notice Emitted when a delegation selector is revoked
	/// @param delegator Address whose delegation is being revoked
	/// @param delegate Address whose delegation is being revoked
	/// @param selector Function selector being revoked
	event DelegationSelectorRevoked(address indexed delegator, address indexed delegate, bytes4 selector);

	/// @notice Emitted when a user's ordered-execution nonce is incremented after operation execution
	/// @param user Address whose nonce was incremented
	/// @param newNonce The new nonce value
	event NonceIncremented(address indexed user, uint256 newNonce);
}
