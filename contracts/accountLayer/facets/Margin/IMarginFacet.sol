// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { VirtualAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

interface IMarginFacetEvents {
	event AddMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
	event RemoveMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
	event EmergencyMarginRecovered(address indexed virtualAccount, address indexed subAccount, uint256 amount);
}

interface IMarginFacet is IMarginFacetEvents, IAccountLayerErrors {
	function addMargin(address virtualAccount, uint256 amount) external;

	function addMarginToNextVA(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId, uint256 amount) external;

	function removeMargin(address virtualAccount, uint256 amount, ISymmio.SingleUpnlSig memory upnlSig) external;

	function emergencyRecoverMargin(address subAccount, uint256 nonce) external;
}
