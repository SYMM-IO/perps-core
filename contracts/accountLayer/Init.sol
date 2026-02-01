// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibDiamond } from "../diamond/libraries/LibDiamond.sol";
import { IDiamondLoupe } from "../diamond/facets/DiamondLoup/IDiamondLoupe.sol";
import { IDiamondCut } from "../diamond/facets/DiamondCut/IDiamondCut.sol";
import { IERC165 } from "../diamond/interfaces/IERC165.sol";
import { AccountLayerStorage } from "./storages/AccountLayerStorage.sol";
import { AccountHubStorage } from "./storages/AccountHubStorage.sol";
import { AffiliateHubStorage } from "./storages/AffiliateHubStorage.sol";
import { LibAccountLayerAccessibility } from "./libraries/LibAccountLayerAccessibility.sol";
import { IAccountLayerErrors } from "./interfaces/IAccountLayerErrors.sol";

contract Init is IAccountLayerErrors {

	function init(address admin, address symmioFeeReceiver, bytes calldata accountManagerImplementation) external {
		if (admin == address(0)) revert ZeroAddress();
		if (symmioFeeReceiver == address(0)) revert ZeroAddress();
		if (accountManagerImplementation.length == 0) revert EmptyArray();

		// Set up diamond interfaces
		LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
		ds.supportedInterfaces[type(IERC165).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
		ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;

		// Set up default admin role
		LibAccountLayerAccessibility.grantRole(admin, LibAccountLayerAccessibility.DEFAULT_ADMIN_ROLE);
		LibAccountLayerAccessibility.grantRole(admin, LibAccountLayerAccessibility.SETTER_ROLE);
		LibAccountLayerAccessibility.grantRole(admin, LibAccountLayerAccessibility.PAUSER_ROLE);
		LibAccountLayerAccessibility.grantRole(admin, LibAccountLayerAccessibility.UNPAUSER_ROLE);
		LibAccountLayerAccessibility.grantRole(admin, LibAccountLayerAccessibility.APPROVER_ROLE);

		// Initialize AccountHub storage
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		ahLayout.accountManagerImplementation = accountManagerImplementation;
		ahLayout.initAccountManagerCodeHash = keccak256(abi.encodePacked(accountManagerImplementation));

		// Initialize AffiliateHub storage
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		afLayout.symmioFeeReceiver = symmioFeeReceiver;
	}
}
