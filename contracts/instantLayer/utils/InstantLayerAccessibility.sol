// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibInstantLayerAccessibility } from "../libraries/LibInstantLayerAccessibility.sol";
import { IInstantLayerErrors } from "../interfaces/IInstantLayerErrors.sol";

/// @notice Role-based access control modifiers for the InstantLayer diamond
abstract contract InstantLayerAccessibility is IInstantLayerErrors {
	/// @notice Restricts access to callers with the specified role
	modifier onlyRole(bytes32 role) {
		if (!LibInstantLayerAccessibility.hasRole(msg.sender, role)) revert MustHaveRole();
		_;
	}

	/// @notice Restricts access to role admins of the specified role
	modifier onlyRoleAdmin(bytes32 role) {
		if (!LibInstantLayerAccessibility.isRoleAdmin(msg.sender, role)) revert MustBeRoleAdmin();
		_;
	}
}
