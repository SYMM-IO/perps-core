// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IAccountLayerErrors {
	error ZeroAddress();
	error EmptyArray();
	error DeploymentFailed();
	error CoreNotFound();
	error InvalidSelector();
	error ZeroAmount();
	error NotVirtualAccount();
	error AccountDoesNotExist();
	error NotOwner();
	error InvalidParent();
	error InvalidNameLength();
	error InvalidShare();
	error SharesMustSumTo100();
	error AlreadyRegistered();
	error NotAdmin();
	error NotPending();
	error NoWhitelistedSymmioCore();
	error NoPendingUpdate();
	error Unauthorized();
	error InvalidState();
	error InvalidCallData();
	error SymmioCoreNotAllowed();
	error AffiliateNotActive();
	error NotAffiliateAdmin();
	error NotSymmioCore();
	error MustHaveRole();
	error MustBeRoleAdmin();
	error OnlyCustomIsolationCanCreateManually();
	error SingleVAModeNotApplicable();
	error HasActiveVirtualAccounts();
	error AlreadyDeleted();
	error OpenPositionsExist();
	error NoActiveHookContext();
	error PositionTypeNotAllowedForThisAccount();
	error SymbolNotAllowedForThisAccount();
	error SelectorNotAllowed(bytes4 selector);
	error HookFailed(bytes reason);
	error HookActionFailed(bytes reason);
}
