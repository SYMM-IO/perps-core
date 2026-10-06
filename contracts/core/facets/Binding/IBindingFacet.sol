// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IBindingEvents } from "./IBindingEvents.sol";

interface IBindingFacet is IBindingEvents {
	function bindToPartyB(address partyB) external;

	function requestToUnbindFromPartyB() external;

	function cancelUnbindRequest() external;

	function completeUnbindRequest(address partyA) external;

	function activateInstantActionMode() external;

	function proposeToDeactivateInstantActionMode() external;

	function deactivateInstantActionMode() external;
}
