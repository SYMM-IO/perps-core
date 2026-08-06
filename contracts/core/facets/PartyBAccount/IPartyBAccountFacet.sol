// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBAccountEvents } from "./IPartyBAccountEvents.sol";
import { SingleUpnlSig, SingleUpnlWithPendingBalanceSig } from "../../storages/MuonStorage.sol";

interface IPartyBAccountFacet is IPartyBAccountEvents {
	function allocateForPartyB(uint256 amount, address partyA) external;

	function deallocateForPartyB(uint256 amount, address partyA, SingleUpnlSig memory upnlSig) external;

	function safeDeallocateForPartyB(uint256 amount, address partyA, SingleUpnlWithPendingBalanceSig memory upnlSig) external;

	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) external;

	function depositToReserveVault(uint256 amount, address partyB) external;

	function withdrawFromReserveVault(uint256 amount) external;

	function activateCrossPartyB() external;
}
