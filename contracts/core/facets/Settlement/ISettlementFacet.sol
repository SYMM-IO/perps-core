// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SettlementFacetEvents } from "./SettlementFacetEvents.sol";
import { SettlementSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";

interface ISettlementFacet is SettlementFacetEvents {
	/// @dev DEPRECATED: Use settleUpnlUnified instead
	function settleUpnl(SettlementSig memory settleSig, uint256[] memory updatedPrices, address partyA) external;

	function settleUpnlUnified(UnifiedSettlementSig memory sig, uint256[] memory updatedPrices) external;

	function settlePartyBUpnlForLiquidation(address liquidatedPartyA, UnifiedSettlementSig memory sig, uint256[] memory updatedPrices) external;
}
