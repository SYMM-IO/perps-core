// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { CrossLiquidationSig } from "../../storages/MuonStorage.sol";
import { IClearingHouseFacetEvents } from "./IClearingHouseFacetEvents.sol";

interface IClearingHouseFacet is IClearingHouseFacetEvents {
	// Initialization functions (different for each flow)
	function liquidateCrossPartyB(address partyB, CrossLiquidationSig memory liquidationSig) external;

	function takeoverPartyALiquidation(address partyA) external;

	// Unified clearing house functions (work for both flows)
	function deallocateForClearingHouse(
		address subject,
		address[] memory parties,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external;

	function distributeForClearingHouse(address subject, address[] memory receivers, address[] memory allocationKeys, uint256[] memory amounts) external;

	function liquidatePendingPositionsForClearingHouse(address subject, address[] memory counterparties) external;

	function liquidatePositionsForClearingHouse(address subject, uint256[] memory quoteIds, uint256[] memory prices) external;

	// Settlement
	function settlePartyATakeover(address partyA, address[] memory settledPartyBs) external;
	function settleCrossPartyBLiquidation(address partyB) external;

	// Soft liquidation
	function softPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance) external;
}
