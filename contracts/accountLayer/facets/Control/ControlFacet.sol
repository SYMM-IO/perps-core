// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IControlFacet } from "./IControlFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountLayerStorage } from "../../storages/AccountLayerStorage.sol";
import { AccountHubStorage } from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage } from "../../storages/AffiliateHubStorage.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";

contract ControlFacet is IControlFacet, AccountLayerAccessibility, AccountLayerPausable {
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	// ==================== Role Management ====================

	function grantRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		LibAccountLayerAccessibility.grantRole(user, role);
		emit RoleGranted(role, user, msg.sender);
	}

	function revokeRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		LibAccountLayerAccessibility.revokeRole(user, role);
		emit RoleRevoked(role, user, msg.sender);
	}

	function setRoleAdmin(address user, bytes32 role, bool status) external onlyRole(LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE) {
		LibAccountLayerAccessibility.setRoleAdmin(user, role, status);
		emit RoleAdminSet(role, user, status, msg.sender);
	}

	function hasRole(address user, bytes32 role) external view returns (bool) {
		return LibAccountLayerAccessibility.hasRole(user, role);
	}

	function isRoleAdmin(address user, bytes32 role) external view returns (bool) {
		return LibAccountLayerAccessibility.isRoleAdmin(user, role);
	}

	// ==================== Pause Control ====================

	function pause() external onlyRole(LibAccountLayerAccessibility.PAUSER_ROLE) {
		_pause();
	}

	function unpause() external onlyRole(LibAccountLayerAccessibility.UNPAUSER_ROLE) {
		_unpause();
	}

	function paused() external view returns (bool) {
		return AccountLayerStorage.layout().globalPaused;
	}

	// ==================== AccountHub Configuration ====================

	function setAccountManagerImplementation(bytes memory implementation) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		if (implementation.length == 0) revert EmptyArray();

		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		bytes memory oldImplementation = ahLayout.accountManagerImplementation;
		ahLayout.accountManagerImplementation = implementation;
		ahLayout.initAccountManagerCodeHash = keccak256(abi.encodePacked(implementation));

		emit AccountManagerImplementationUpdated(oldImplementation, implementation);
	}

	function setSigner(address _signer) external onlyRole(LibAccountLayerAccessibility.SIGNER_SETTER_ROLE) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		address oldSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = _signer;

		emit SignerUpdated(oldSigner, _signer);
	}

	// ==================== AffiliateHub Configuration ====================

	function setSymmioFeeReceiver(address receiver) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		if (receiver == address(0)) revert ZeroAddress();

		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		address oldReceiver = afLayout.symmioFeeReceiver;
		afLayout.symmioFeeReceiver = receiver;

		emit SymmioFeeReceiverUpdated(oldReceiver, receiver);
	}

	function setWhitelistedSymmioCore(address core, bool status) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		AffiliateHubStorage.layout().whitelistedSymmioCores[core] = status;
		emit WhitelistedSymmioCoreSet(core, status);
	}

	function setHookAllowedSelectors(
		address affiliate,
		bytes4[] calldata selectors,
		bool allowed
	) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		for (uint256 i = 0; i < selectors.length; i++) {
			afLayout.hookAllowedSelectors[affiliate][selectors[i]] = allowed;
		}
		emit HookAllowedSelectorsSet(affiliate, selectors, allowed);
	}

	function setCallAllowedSelectors(
		address affiliate,
		bytes4[] calldata selectors,
		bool allowed
	) external onlyRole(LibAccountLayerAccessibility.SETTER_ROLE) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		for (uint256 i = 0; i < selectors.length; i++) {
			afLayout.callAllowedSelectors[affiliate][selectors[i]] = allowed;
		}
		emit CallAllowedSelectorsSet(affiliate, selectors, allowed);
	}
}
