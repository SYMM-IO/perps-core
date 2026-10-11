// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title InstantLayerStorage
/// @notice Global configuration and access control for the InstantLayer diamond.
/// @dev Slot-isolated from ExecutionStorage, DelegationStorage and TemplateStorage so each
///      concern can evolve independently. Written only by Init and the control facet.
library InstantLayerStorage {
	bytes32 internal constant INSTANT_LAYER_STORAGE_SLOT = keccak256("diamond.standard.storage.instantlayer.global");

	struct Layout {
		/// @notice Address of the core Symmio protocol contract.
		/// @dev Set once during initialization; there is no setter.
		address symmio;
		/// @notice Configured AccountLayer contract.
		/// @dev Settable by SETTER_ROLE.
		address accountLayer;
		/// @notice Whether execution uses the native begin/end context selectors.
		/// @dev Both settings use EIP-1153 transient storage in this build. Disabling the flag
		///      selects the historical setter sequence without changing signed operations or templates.
		bool transientContextEnabled;
		/// @notice Whether the diamond has completed initialization.
		bool initialized;
		/// @notice Registry of whitelisted call targets.
		mapping(address => bool) whitelistedTargets;
		/// @notice Registry of authorized PartyB contracts.
		/// @dev PartyB contracts must be registered before they can execute operations.
		mapping(address => bool) registeredPartyBs;
		/// @notice Role-based access control.
		/// @dev Maps user => role hash => has_role. Roles are SETTER_ROLE, OPERATOR_ROLE,
		///      REVOKER_ROLE and DEFAULT_ADMIN_ROLE.
		mapping(address => mapping(bytes32 => bool)) hasRole;
		/// @notice Who can grant and revoke each role.
		/// @dev Maps role => admin => is_admin. Holders of DEFAULT_ADMIN_ROLE are admins of
		///      every role without an entry here.
		mapping(bytes32 => mapping(address => bool)) roleAdmins;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = INSTANT_LAYER_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
