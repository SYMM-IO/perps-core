// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBLiquidationEvents } from "./IPartyBLiquidationEvents.sol";
import { SingleUpnlSig, QuotePriceSig } from "../../storages/MuonStorage.sol";

interface IPartyBLiquidationFacet is IPartyBLiquidationEvents {
	function liquidatePartyB(address partyB, address partyA, SingleUpnlSig memory upnlSig) external;

	function liquidatePositionsPartyB(address partyB, address partyA, QuotePriceSig memory priceSig) external;
}
