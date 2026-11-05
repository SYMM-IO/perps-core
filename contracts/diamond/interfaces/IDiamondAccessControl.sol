// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Canonical role-management interface shared by every SYMMIO diamond.
/// @dev The diamond owner appoints default admins. Default admins may appoint role-specific
///      admins, and either kind of role admin may grant or revoke the role they administer.
interface IDiamondAccessControl {
	function setAdmin(address user) external;

	function grantRole(address user, bytes32 role) external;

	function revokeRole(address user, bytes32 role) external;

	function addRoleAdmin(bytes32 role, address admin) external;

	function removeRoleAdmin(bytes32 role, address admin) external;
}

/// @notice Canonical role-query interface shared by every SYMMIO diamond.
interface IDiamondAccessControlView {
	function hasRole(address user, bytes32 role) external view returns (bool);

	function isRoleAdmin(address user, bytes32 role) external view returns (bool);
}
