// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SubAccountCreationData, VirtualAccountIsolationType } from "../../storages/AccountHubStorage.sol";

interface ICoreFacetEvents {
	event SubAccountCreated(address indexed account, address indexed owner, address indexed affiliate, string name);
	event VirtualAccountCreated(address indexed account, address indexed parent);
	event VirtualAccountReused(address indexed account, address indexed parent);
	event VirtualAccountDeleted(address indexed account, address indexed parent);
	event SingleVAModeChanged(address indexed subAccount, bool enabled);
	event EditAccountName(address indexed account, string name);
	event Call(address indexed sender, address indexed account, bytes callData, bool success, bytes resultData);
}

interface ICoreFacet is ICoreFacetEvents {
	// ==================== Sub-Account Management ====================

	function createSubAccounts(address affiliate, SubAccountCreationData[] memory accountsData) external returns (address[] memory);

	function editAccountName(address account, string memory name) external;

	function setSingleVAMode(address subAccount, bool enabled) external;

	// ==================== Virtual Account Management ====================

	function createCustomVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external returns (address);

	// ==================== Call Execution ====================

	function _call(address account, bytes[] calldata callDatas) external returns (bytes[] memory);

	// ==================== Custom Errors ====================

	error ZeroAddress();
	error NotSymmioCore();
	error EmptyArray();
	error NotOwner();
	error InvalidParent();
	error AccountDoesNotExist();
	error InvalidNameLength();
	error AffiliateNotActive();
	error OnlyCustomIsolationCanCreateManually();
	error HookFailed(bytes reason);
	error HasActiveVirtualAccounts();
	error SingleVAModeNotApplicable();
	error PositionTypeNotAllowedForThisAccount();
	error SymbolNotAllowedForThisAccount();
	error AlreadyDeleted();
	error OpenPositionsExist();
}
