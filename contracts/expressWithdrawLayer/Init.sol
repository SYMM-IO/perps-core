// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { LibAccessControl } from "./libraries/LibAccessControl.sol";
import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { LibErrors } from "./libraries/LibErrors.sol";

import { IDiamondLoupe } from "../diamond/facets/DiamondLoup/IDiamondLoupe.sol";
import { IERC165 } from "../diamond/interfaces/IERC165.sol";

import { GlobalStorage } from "./storages/GlobalStorage.sol";
import { ValidatorStorage } from "./storages/ValidatorStorage.sol";

/// @title Init
/// @notice Initialization contract for the ExpressProvider diamond.
/// @dev Executed via delegatecall during the diamond cut to set up initial state.
contract Init {
	function init(address admin, address _symmio, address _collateral) external {
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		if (s.initialized) revert LibErrors.AlreadyInitialized();
		s.initialized = true;

		LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
		ds.supportedInterfaces[type(IERC165).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;

		s.symmio = _symmio;
		s.collateral = IERC20(_collateral);
		s.securityWindow = 20;
		s.tolerancePeriod = 60;
		ValidatorStorage.layout().validatorApprovalTimeout[address(0)] = 30;

		s.hashedName = keccak256(bytes("ExpressProvider"));
		s.hashedVersion = keccak256(bytes("1"));

		LibAccessControl.grantRole(admin, LibAccessControl.SETTER_ROLE);
		LibAccessControl.grantRole(admin, LibAccessControl.SPONSOR_MANAGER_ROLE);
		LibAccessControl.grantRole(admin, LibAccessControl.FEE_CLAIMER_ROLE);
		LibAccessControl.grantRole(admin, LibAccessControl.WITHDRAWER_ROLE);
		LibAccessControl.grantRole(admin, LibAccessControl.PAUSER_ROLE);
	}
}
