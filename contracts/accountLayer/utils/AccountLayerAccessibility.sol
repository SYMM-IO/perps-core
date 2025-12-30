// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibAccountLayerAccessibility } from "../libraries/LibAccountLayerAccessibility.sol";
import { LibAccountLayerUtils } from "../libraries/LibAccountLayerUtils.sol";
import { AffiliateHubStorage, AffiliateState } from "../storages/AffiliateHubStorage.sol";
import { AccountHubStorage } from "../storages/AccountHubStorage.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

abstract contract AccountLayerAccessibility is IAccountLayerErrors {
	modifier onlyRole(bytes32 role) {
		if (!LibAccountLayerAccessibility.hasRole(msg.sender, role)) revert MustHaveRole();
		_;
	}

	modifier onlyRoleAdmin(bytes32 role) {
		if (!LibAccountLayerAccessibility.isRoleAdmin(msg.sender, role)) revert MustBeRoleAdmin();
		_;
	}

	modifier onlyAffiliateAdmin(address affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].admin != msg.sender) revert NotAffiliateAdmin();
		_;
	}

	modifier onlyIfAffiliateIsActive(address affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();
		_;
	}

	modifier onlySymmio() {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (!afLayout.whitelistedSymmioCores[msg.sender]) revert NotSymmioCore();
		_;
	}

	modifier onlyAccountOwner(address account) {
		if (!_isOwnerOf(account, msg.sender)) revert NotOwner();
		_;
	}

	function _isOwnerOf(address account, address user) internal view returns (bool) {
		return LibAccountLayerUtils.resolveAccountOwner(account) == user;
	}
}
