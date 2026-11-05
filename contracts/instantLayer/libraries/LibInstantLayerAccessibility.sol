// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { InstantLayerStorage } from "../storages/InstantLayerStorage.sol";

/// @notice Role-based access control library for the InstantLayer diamond
/// @dev Argument order here is (user, role), mirroring LibAccountLayerAccessibility. The
///      ControlFacet externals keep the OpenZeppelin (role, account) order that existing
///      callers already encode, so the facet transposes the arguments at every call site.
library LibInstantLayerAccessibility {
	bytes32 public constant DEFAULT_ADMIN_ROLE = keccak256("DEFAULT_ADMIN_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant TEMPLATE_MANAGER_ROLE = keccak256("TEMPLATE_MANAGER_ROLE");
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
	bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");
	bytes32 public constant MIGRATOR_ROLE = keccak256("MIGRATOR_ROLE");

	/// @notice Checks whether a user has been granted a specific role
	function hasRole(address user, bytes32 role) internal view returns (bool) {
		InstantLayerStorage.Layout storage layout = InstantLayerStorage.layout();
		return layout.hasRole[user][role];
	}

	/// @notice Checks whether a user is a role admin for a specific role (or is DEFAULT_ADMIN)
	function isRoleAdmin(address user, bytes32 role) internal view returns (bool) {
		InstantLayerStorage.Layout storage layout = InstantLayerStorage.layout();
		return layout.roleAdmins[role][user] || layout.hasRole[user][DEFAULT_ADMIN_ROLE];
	}

	/// @notice Grants a role to a user
	function grantRole(address user, bytes32 role) internal {
		InstantLayerStorage.Layout storage layout = InstantLayerStorage.layout();
		layout.hasRole[user][role] = true;
	}

	/// @notice Revokes a role from a user
	function revokeRole(address user, bytes32 role) internal {
		InstantLayerStorage.Layout storage layout = InstantLayerStorage.layout();
		layout.hasRole[user][role] = false;
	}

	/// @notice Adds or removes a user as role admin for a specific role
	function setRoleAdmin(address user, bytes32 role, bool status) internal {
		InstantLayerStorage.Layout storage layout = InstantLayerStorage.layout();
		layout.roleAdmins[role][user] = status;
	}
}
