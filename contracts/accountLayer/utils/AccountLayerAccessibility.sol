// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibAccountLayerAccessibility } from "../libraries/LibAccountLayerAccessibility.sol";
import { LibAccountLayerUtils } from "../libraries/LibAccountLayerUtils.sol";
import { AffiliateStorage, AffiliateState } from "../storages/AffiliateStorage.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

/// @notice Role-based and ownership access control modifiers for the AccountLayer diamond
abstract contract AccountLayerAccessibility is IAccountLayerErrors {
	/// @notice Restricts access to callers with the specified role
	modifier onlyRole(bytes32 role) {
		if (!LibAccountLayerAccessibility.hasRole(msg.sender, role)) revert MustHaveRole();
		_;
	}

	/// @notice Restricts access to role admins of the specified role
	modifier onlyRoleAdmin(bytes32 role) {
		if (!LibAccountLayerAccessibility.isRoleAdmin(msg.sender, role)) revert MustBeRoleAdmin();
		_;
	}

	/// @notice Restricts access to the admin of the specified affiliate
	modifier onlyAffiliateAdmin(address affiliate) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		if (afLayout.affiliates[affiliate].admin != msg.sender) revert NotAffiliateAdmin();
		_;
	}

	/// @notice Restricts access to only when the specified affiliate is in ACTIVE state
	modifier onlyIfAffiliateIsActive(address affiliate) {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();
		_;
	}

	/// @notice Restricts access to whitelisted Symmio core contracts
	modifier onlySymmio() {
		AffiliateStorage.Layout storage afLayout = AffiliateStorage.layout();
		if (!afLayout.whitelistedSymmioCores[msg.sender]) revert NotSymmioCore();
		_;
	}

	/// @notice Restricts access to the account owner (verified via getSigner), within the session's account scope
	/// @dev Ownership alone is too coarse for delegated sessions: an owner owns every one of their
	///      sub-accounts, so an owner-level signer satisfies this check for all of them. When a caller
	///      acts for a delegate it also sets a scope, and the second check confines the call to the
	///      account family that delegation was granted over. Unscoped sessions are unaffected.
	modifier onlyAccountOwner(address account) {
		address signer = LibAccountLayerUtils.getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		LibAccountLayerUtils.requireAccountInScope(account);
		_;
	}

	/// @notice Checks whether a user is the owner of the given account
	function _isOwnerOf(address account, address user) internal view returns (bool) {
		return LibAccountLayerUtils.resolveAccountOwner(account) == user;
	}
}
