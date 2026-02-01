// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title AccountLayerStorage
/// @notice Access control and pause state for AffiliateHub and AccountHub
/// @dev The account layer diamond has its own RBAC separate from perps-core.
///      Key roles: APPROVER_ROLE (activates affiliates, approves fee updates),
///      SETTER_ROLE (manages core whitelists), DEPLOYER_ROLE (deploys AccountManagers).
library AccountLayerStorage {
	bytes32 internal constant ACCOUNT_LAYER_STORAGE_SLOT = keccak256("diamond.standard.storage.accountlayer");

	struct Layout {
		/// @notice Role-based access control
		/// @dev Maps user => role hash => has_role. Roles include APPROVER_ROLE,
		///      SETTER_ROLE, DEPLOYER_ROLE, DISTRIBUTOR_ROLE, SIGNER_SETTER_ROLE.
		mapping(address => mapping(bytes32 => bool)) hasRole;
		/// @notice Who can grant/revoke each role
		/// @dev Maps role => admin => is_admin. Role admins manage hasRole for their role.
		mapping(bytes32 => mapping(address => bool)) roleAdmins;
		/// @notice Global pause switch for the account layer
		/// @dev When true, all account layer operations are blocked. Independent from
		///      perps-core globalPaused.
		bool globalPaused;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = ACCOUNT_LAYER_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
