// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IClearingHouseFacetEvents {
	// Cross PartyB liquidation init event
	event LiquidateCrossPartyB(address indexed initiator, address indexed partyB, bytes liquidationId, int256 upnl, uint256 timestamp);

	// PartyA takeover init event
	event TakeoverPartyALiquidation(address indexed partyA, bytes liquidationId, uint256 timestamp);

	// Unified clearing house events (work for both cross PartyB and PartyA takeover)
	event DeallocateForClearingHouse(address indexed subject, address[] parties, address[] allocationKeys, uint256[] amounts);
	event DistributeForClearingHouse(address indexed subject, address[] receivers, address[] allocationKeys, uint256[] amounts);
	event LiquidatePendingPositionsForClearingHouse(address indexed subject, address[] counterparties, uint256[] liquidatedAmounts);
	event LiquidatePositionsForClearingHouse(
		address indexed subject,
		uint256[] quoteIds,
		uint256[] liquidatedAmounts,
		uint256[] closeIds,
		uint256[] prices
	);

	// Settlement events
	event SettlePartyATakeover(address indexed partyA, bytes liquidationId);
	event SettleCrossPartyBLiquidation(address indexed partyB);

	// Soft liquidation event
	event SoftPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance);
}
