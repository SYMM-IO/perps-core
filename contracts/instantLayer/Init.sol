// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { IDiamondLoupe } from "../diamond/facets/DiamondLoup/IDiamondLoupe.sol";
import { IDiamondCut } from "../diamond/facets/DiamondCut/IDiamondCut.sol";
import { IERC165 } from "../diamond/interfaces/IERC165.sol";
import { InstantLayerStorage } from "./storages/InstantLayerStorage.sol";
import { ExecutionStorage } from "./storages/ExecutionStorage.sol";
import { DelegationStorage } from "./storages/DelegationStorage.sol";
import { LibInstantLayerAccessibility } from "./libraries/LibInstantLayerAccessibility.sol";
import { IInstantLayerErrors } from "./interfaces/IInstantLayerErrors.sol";
import { IInstantLayerEvents } from "./interfaces/IInstantLayerEvents.sol";

/// @notice Initialization contract for the InstantLayer diamond
contract Init is IInstantLayerErrors, IInstantLayerEvents {
	/// @notice Sets the diamond's starting configuration and grants the admin its initial roles
	/// @dev Reproduces the defaults the monolithic InstantLayer applied in its constructor.
	///      REVOKER_ROLE is granted separately, as it was there.
	/// @param _symmio Address of the core Symmio protocol contract
	/// @param _admin Address to receive DEFAULT_ADMIN_ROLE, SETTER_ROLE, TEMPLATE_MANAGER_ROLE, and OPERATOR_ROLE
	function init(address _symmio, address _admin) external {
		if (_symmio == address(0) || _admin == address(0)) revert ZeroAddress();
		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();
		if (l.initialized) revert AlreadyInitialized();
		l.initialized = true;
		l.symmio = _symmio;

		// Seeds the reentrancy guard's slot to its not-entered value (1, not the field's zero
		// default) so the first executeBatch/executeTemplate call after deployment pays a warm
		// SSTORE instead of a cold one. Not load-bearing for correctness: InstantLayerReentrancyGuard's
		// enter check reads a bare zero slot as not-entered too, since it only compares against 2.
		ExecutionStorage.layout().reentrancyStatus = 1;

		LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
		ds.supportedInterfaces[type(IERC165).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;

		l.transientContextEnabled = true;
		emit TransientContextEnabledUpdated(true);

		// Each genesis grant emits, as the monolith's OZ _grantRole did. This diamond has no
		// getRoleMember or getRoleMemberCount, so these logs are the only way an indexer can
		// learn that the admin holds anything.
		LibInstantLayerAccessibility.grantRole(_admin, LibInstantLayerAccessibility.DEFAULT_ADMIN_ROLE);
		emit RoleGranted(LibInstantLayerAccessibility.DEFAULT_ADMIN_ROLE, _admin, msg.sender);
		LibInstantLayerAccessibility.grantRole(_admin, LibInstantLayerAccessibility.SETTER_ROLE);
		emit RoleGranted(LibInstantLayerAccessibility.SETTER_ROLE, _admin, msg.sender);
		LibInstantLayerAccessibility.grantRole(_admin, LibInstantLayerAccessibility.TEMPLATE_MANAGER_ROLE);
		emit RoleGranted(LibInstantLayerAccessibility.TEMPLATE_MANAGER_ROLE, _admin, msg.sender);
		LibInstantLayerAccessibility.grantRole(_admin, LibInstantLayerAccessibility.OPERATOR_ROLE);
		emit RoleGranted(LibInstantLayerAccessibility.OPERATOR_ROLE, _admin, msg.sender);

		DelegationStorage.layout().revocationCooldown = 10 minutes;
		emit RevocationCooldownUpdated(0, 10 minutes);

		l.whitelistedTargets[_symmio] = true;
		emit TargetWhitelistUpdated(_symmio, true);
	}
}
