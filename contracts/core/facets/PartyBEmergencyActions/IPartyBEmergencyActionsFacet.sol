// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBEmergencyActionsEvents } from "./IPartyBEmergencyActionsEvents.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

interface IPartyBEmergencyActionsFacet is IPartyBEmergencyActionsEvents {
	/// @notice Fully closes a quote during a configured emergency or when adjustment rounding makes it unrestatable.
	/// @dev The adjustment-dust exception applies only while frozen; Muon must provide price and UPNLs in the quote's current stored basis.
	function emergencyClosePosition(uint256 quoteId, PairUpnlAndPriceSig memory upnlSig) external;

	function adlClose(uint256 quoteId, uint256 amount, uint256 price) external;
}
