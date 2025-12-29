// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountLayerStorage } from "../storages/AccountLayerStorage.sol";

library LibAccountLayerAccessibility {
	bytes32 public constant DEFAULT_ADMIN_ROLE = keccak256("DEFAULT_ADMIN_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant SIGNER_SETTER_ROLE = keccak256("SIGNER_SETTER_ROLE");
	bytes32 public constant INSTANT_LAYER_ROLE = keccak256("INSTANT_LAYER_ROLE");
	bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");
	bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
	bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

	function hasRole(address user, bytes32 role) internal view returns (bool) {
		AccountLayerStorage.Layout storage layout = AccountLayerStorage.layout();
		return layout.hasRole[user][role];
	}

	function isRoleAdmin(address user, bytes32 role) internal view returns (bool) {
		AccountLayerStorage.Layout storage layout = AccountLayerStorage.layout();
		return layout.roleAdmins[role][user] || layout.hasRole[user][DEFAULT_ADMIN_ROLE];
	}

	function grantRole(address user, bytes32 role) internal {
		AccountLayerStorage.Layout storage layout = AccountLayerStorage.layout();
		layout.hasRole[user][role] = true;
	}

	function revokeRole(address user, bytes32 role) internal {
		AccountLayerStorage.Layout storage layout = AccountLayerStorage.layout();
		layout.hasRole[user][role] = false;
	}

	function setRoleAdmin(address user, bytes32 role, bool status) internal {
		AccountLayerStorage.Layout storage layout = AccountLayerStorage.layout();
		layout.roleAdmins[role][user] = status;
	}
}
