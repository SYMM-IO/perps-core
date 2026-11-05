// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Account, DelegationInfo, Operation, Template, SignedOperation, SignedDelegation } from "../../InstantLayerTypes.sol";
import { IInstantLayerErrors } from "../../interfaces/IInstantLayerErrors.sol";

/// @notice Read-only interface for the InstantLayer diamond
/// @dev Named IInstantLayerViewFacet, not IViewFacet, so it does not collide with AccountLayer's
///      IViewFacet when both are imported into the same composite context.
interface IInstantLayerViewFacet is IInstantLayerErrors {
	// ==================== Moved view functions ====================

	/// @notice Check if an address is a registered PartyB contract.
	/// @param addr Address to check
	/// @return True if registered, false otherwise
	function isPartyBRegistered(address addr) external view returns (bool);

	/// @notice Check if a delegation is currently active.
	/// @param delegator Address that granted delegation
	/// @param delegate  Address that received delegation
	/// @param selector  Function selector to check
	/// @return True if delegation is active, false otherwise
	function isDelegationActive(address delegator, address delegate, bytes4 selector) external view returns (bool);

	/// @notice Get all currently active delegations for a delegator.
	/// @param _delegator Account to check delegations for
	/// @param delegates Array of potential delegates to check
	/// @param selectors  Array of selector arrays to check for each delegate
	/// @return activeDelegates Array of active delegation information
	function getActiveDelegations(
		Account calldata _delegator,
		address[] calldata delegates,
		bytes4[][] calldata selectors
	) external view returns (DelegationInfo[] memory activeDelegates);

	/// @notice Get the EIP-712 domain separator.
	/// @return Domain separator for signature verification
	function domainSeparator() external view returns (bytes32);

	/// @notice ERC-5267 description of the EIP-712 domain
	function eip712Domain()
		external
		view
		returns (
			bytes1 fields,
			string memory name,
			string memory version,
			uint256 chainId,
			address verifyingContract,
			bytes32 salt,
			uint256[] memory extensions
		);

	/// @notice Get complete template information.
	/// @param templateId Template ID to query
	/// @return Complete template structure
	function getTemplate(uint256 templateId) external view returns (Template memory);

	/// @notice Get the next assigned template ID.
	/// @return Current value of the template ID counter
	function getNextTemplateId() external view returns (uint256);

	/// @notice Get all operations for a template.
	/// @param templateId Template ID to query
	/// @return Array of operation configurations
	function getTemplateOperations(uint256 templateId) external view returns (Operation[] memory);

	/// @notice Get templates by ID range.
	/// @param startId Starting template ID
	/// @param limit   Maximum number of templates to return
	/// @return Array of templates in the specified range
	function getTemplates(uint256 startId, uint256 limit) external view returns (Template[] memory);

	/// @notice Calculate the EIP-712 hash for a signed operation.
	/// @param signedOp Operation to hash
	/// @return msgDigest EIP-712 compliant hash
	function getOperationHash(SignedOperation memory signedOp) external view returns (bytes32 msgDigest);

	/// @notice Calculate the EIP-712 hash for a flex fill authorization.
	/// @param opHash     Hash of the flex operation being filled
	/// @param fieldIndex Index of the flex field being filled
	/// @param value      The fill value bytes
	/// @return msgDigest EIP-712 compliant hash
	function getFlexFillAuthHash(bytes32 opHash, uint256 fieldIndex, bytes memory value) external view returns (bytes32 msgDigest);

	/// @notice Calculate the EIP-712 hash for a signed delegation.
	/// @param signedDelegation Delegation to hash
	/// @return msgDigest EIP-712 compliant hash
	function getDelegationHash(SignedDelegation memory signedDelegation) external view returns (bytes32 msgDigest);

	// ==================== Ownership ====================

	/// @notice Returns the current diamond owner address
	function getOwner() external view returns (address);

	/// @notice Returns the pending owner address (for two-step ownership transfer)
	function pendingOwner() external view returns (address);

	// ==================== Explicit getters (auto-getter replacements) ====================

	/// @notice Sequential nonce tracking per address for ordered execution.
	function nonces(address account) external view returns (uint256);

	/// @notice Registry of authorized PartyB contracts.
	function registeredPartyBs(address partyB) external view returns (bool);

	/// @notice Registry of whitelisted call targets.
	function whitelistedTargets(address target) external view returns (bool);

	/// @notice Configured AccountLayer contract.
	function accountLayer() external view returns (address);

	/// @notice Address of the core Symmio protocol contract.
	function symmio() external view returns (address);

	/// @notice Tracking of operation usage counts for replay protection.
	function operationUsageCount(bytes32 opHash) external view returns (uint256);

	/// @notice Templates that skip pending balance tracking (send+lock+open flows).
	function templateInstantOpenMode(uint256 templateId) external view returns (bool);

	/// @notice Tracking of executed delegation hashes to prevent replay attacks.
	function usedDelegationHashes(bytes32 hash) external view returns (bool);

	/// @notice Delegation permissions: delegator => delegate => selector => expiry timestamp.
	function delegations(address delegator, address delegate, bytes4 selector) external view returns (uint256);

	/// @notice Sequential nonce for delegation signatures to prevent replay.
	function delegationNonces(address delegator) external view returns (uint256);

	/// @notice Scheduled revocation ETA: delegator => delegate => selector => eta (0 = none scheduled).
	function pendingRevocationEta(address delegator, address delegate, bytes4 selector) external view returns (uint256);

	/// @notice Cooldown period for revoking delegation permissions, in seconds.
	function revocationCooldown() external view returns (uint256);

	/// @notice Counter for generating unique sequential template IDs.
	function nextTemplateId() external view returns (uint256);

	/// @notice Whether execution uses the native begin/end context selectors.
	function transientContextEnabled() external view returns (bool);

	/// @notice Storage for all operation templates indexed by template ID.
	/// @dev Mirrors the monolith's auto-getter tuple shape: the dynamic operations array member
	///      is omitted, leaving only name and active.
	function templates(uint256 templateId) external view returns (string memory name, bool active);

	// ==================== Role queries ====================

	/// @notice Reports whether an account holds a role
	/// @dev Keeps the OpenZeppelin (role, account) order of the role externals on the control
	///      facet, unlike isRoleAdmin below.
	/// @param role The role identifier to check
	/// @param account The address to check
	function hasRole(bytes32 role, address account) external view returns (bool);

	/// @notice Whether `user` may grant and revoke `role`: a per-role admin, or a holder of DEFAULT_ADMIN_ROLE.
	/// @dev A per-role admin keeps this right after renouncing every role, so hand-over checks read it too.
	function isRoleAdmin(address user, bytes32 role) external view returns (bool);

	// ==================== Constant getters ====================

	/// @notice Default admin role identifier.
	/// @dev keccak256("DEFAULT_ADMIN_ROLE"), not OpenZeppelin's bytes32(0) — a pinned spec
	///      decision for this diamond, matching LibInstantLayerAccessibility.
	function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

	/// @notice Role identifier for managing contract configuration and templates.
	function SETTER_ROLE() external view returns (bytes32);

	/// @notice Role identifier for adding templates and switching them on or off.
	function TEMPLATE_MANAGER_ROLE() external view returns (bytes32);

	/// @notice Role identifier for executing operations and templates.
	function OPERATOR_ROLE() external view returns (bytes32);

	/// @notice Role identifier for revoking delegation permissions.
	function REVOKER_ROLE() external view returns (bytes32);

	/// @notice EIP-712 type hash for Account struct.
	function ACCOUNT_TYPEHASH() external view returns (bytes32);

	/// @notice EIP-712 type hash for ReplayAttackHeader struct.
	function REPLAY_HEADER_TYPEHASH() external view returns (bytes32);

	/// @notice EIP-712 type hash for FlexField struct.
	function FLEX_FIELD_TYPEHASH() external view returns (bytes32);

	/// @notice EIP-712 type hash for FlexFillAuth (flex filler signing fill values).
	function FLEX_FILL_AUTH_TYPEHASH() external view returns (bytes32);

	/// @notice EIP-712 type hash for DelegationInfo struct.
	function DELEGATION_INFO_TYPEHASH() external view returns (bytes32);

	/// @notice EIP-712 type hash for SignedDelegation struct.
	function SIGNED_DELEGATION_TYPEHASH() external view returns (bytes32);
}
