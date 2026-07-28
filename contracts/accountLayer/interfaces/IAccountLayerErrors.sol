// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Custom errors used across the AccountLayer diamond
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
	error InvalidIsolationType();
	error InvalidNonce();
	error AccountAlreadyExists();
	error MustHaveRole();
	error MustBeRoleAdmin();
	error OnlyCustomIsolationCanCreateManually();
	error SingleVAModeNotApplicable();
	error HasActiveVirtualAccounts();
	error AlreadyDeleted();
	error OpenPositionsExist();
	error SubAccountNotEmpty();
	error PendingQuotesExist();
	error NoActiveHookContext();
	error PositionTypeNotAllowedForThisAccount();
	error SymbolNotAllowedForThisAccount();
	error SelectorNotAllowed(bytes4 selector);
	/// @notice The signer session is confined to one account family and the call targeted a different one
	/// @param scope Canonical sub-account the session is confined to
	/// @param account Account the call attempted to act on
	error AccountOutOfScope(address scope, address account);
	error UnauthorizedHookCaller();
	error HookFailed(bytes reason);
	error HookActionFailed(bytes reason);
	error ReentrancyGuardReentrantCall();
	error EnforcedPause();
	error ExpectedPause();
	error ExternalCallFailed();
	error LegacyAccountNotOwned();
	error LegacyContractNotRegistered();
	error MarginKeyMismatch();
}
