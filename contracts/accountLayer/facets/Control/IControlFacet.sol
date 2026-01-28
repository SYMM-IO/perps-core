// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

interface IControlFacetEvents {
	event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
	event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
	event RoleAdminSet(bytes32 indexed role, address indexed account, bool status, address indexed sender);
	event AccountManagerImplementationUpdated(bytes oldImplementation, bytes newImplementation);
	event SignerUpdated(address oldSigner, address newSigner);
	event SymmioFeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
	event WhitelistedSymmioCoreSet(address indexed core, bool status);
	event AccountManagerDeployed(address indexed affiliate, address indexed accountManager);
	event HookAllowedSelectorsSet(address indexed affiliate, bytes4[] selectors, bool allowed);
	event CallAllowedSelectorsSet(address indexed affiliate, bytes4[] selectors, bool allowed);
}

interface IControlFacet is IControlFacetEvents, IAccountLayerErrors {
	// ==================== Role Management ====================

	function grantRole(address user, bytes32 role) external;

	function revokeRole(address user, bytes32 role) external;

	function setRoleAdmin(address user, bytes32 role, bool status) external;

	function hasRole(address user, bytes32 role) external view returns (bool);

	function isRoleAdmin(address user, bytes32 role) external view returns (bool);

	// ==================== Pause Control ====================

	function pause() external;

	function unpause() external;

	function paused() external view returns (bool);

	// ==================== AccountHub Configuration ====================

	function setAccountManagerImplementation(bytes memory implementation) external;

	function setSigner(address _signer) external;

	// ==================== AffiliateHub Configuration ====================

	function setSymmioFeeReceiver(address receiver) external;

	function setWhitelistedSymmioCore(address core, bool status) external;

	function setHookAllowedSelectors(address affiliate, bytes4[] calldata selectors, bool allowed) external;

	function setCallAllowedSelectors(address affiliate, bytes4[] calldata selectors, bool allowed) external;

}
