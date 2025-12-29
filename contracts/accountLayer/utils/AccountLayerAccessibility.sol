// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibAccountLayerAccessibility } from "../libraries/LibAccountLayerAccessibility.sol";
import { AffiliateHubStorage, AffiliateState } from "../storages/AffiliateHubStorage.sol";
import { AccountHubStorage } from "../storages/AccountHubStorage.sol";

abstract contract AccountLayerAccessibility {
	modifier onlyRole(bytes32 role) {
		require(LibAccountLayerAccessibility.hasRole(msg.sender, role), "AccountLayer: Must have role");
		_;
	}

	modifier onlyRoleAdmin(bytes32 role) {
		require(LibAccountLayerAccessibility.isRoleAdmin(msg.sender, role), "AccountLayer: Must be role admin");
		_;
	}

	modifier onlyAffiliateAdmin(address affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		require(afLayout.affiliates[affiliate].admin == msg.sender, "AccountLayer: Not affiliate admin");
		_;
	}

	modifier onlyIfAffiliateIsActive(address affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		require(afLayout.affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountLayer: Affiliate not active");
		_;
	}

	modifier onlySymmio() {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		require(afLayout.whitelistedSymmioCores[msg.sender], "AccountLayer: Not Symmio core");
		_;
	}

	modifier onlyAccountOwner(address account) {
		require(_isOwnerOf(account, msg.sender), "AccountLayer: Not owner");
		_;
	}

	function _isOwnerOf(address account, address user) internal view returns (bool) {
		return _resolveAccountOwner(account) == user;
	}

	function _resolveAccountOwner(address account) internal view virtual returns (address);
}
