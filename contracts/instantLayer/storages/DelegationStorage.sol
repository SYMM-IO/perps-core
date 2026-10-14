// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title DelegationStorage
/// @notice Delegation grants, revocation scheduling, and replay tracking for InstantLayer.
/// @dev Slot-isolated from InstantLayerStorage, ExecutionStorage and TemplateStorage so each
///      concern can evolve independently.
library DelegationStorage {
	bytes32 internal constant DELEGATION_STORAGE_SLOT = keccak256("diamond.standard.storage.instantlayer.delegation");

	struct Layout {
		/// @notice Delegation permissions: delegator => delegate => selector => expiry timestamp.
		/// @dev Non-zero timestamp indicates active delegation until that time.
		mapping(address => mapping(address => mapping(bytes4 => uint256))) delegations;
		/// @notice Scheduled revocation ETA: delegator => delegate => selector => eta (0 = none scheduled).
		mapping(address => mapping(address => mapping(bytes4 => uint256))) pendingRevocationEta;
		/// @notice Sequential nonce for delegation signatures to prevent replay.
		mapping(address => uint256) delegationNonces;
		/// @notice Tracking of executed delegation hashes to prevent replay attacks.
		/// @dev Each delegation can only be executed once.
		mapping(bytes32 => bool) usedDelegationHashes;
		/// @notice Cooldown period for revoking delegation permissions.
		/// @dev Settable by SETTER_ROLE.
		uint256 revocationCooldown; // in seconds
		/// @notice AccountLayer ownership epoch at each selector grant. Legacy grants have epoch zero.
		mapping(address => mapping(address => mapping(bytes4 => uint256))) ownershipEpochs;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = DELEGATION_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
