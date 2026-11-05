// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";

interface IClearingHouseFacetEvents is IPartiesEvents {
	// Cross PartyB liquidation init event
	event LiquidateCrossPartyB(address indexed initiator, address indexed partyB, bytes liquidationId, int256 upnl, uint256 timestamp);

	// PartyA takeover init event
	event TakeoverPartyALiquidation(address indexed partyA, bytes liquidationId, uint256 timestamp);

	// Unified clearing house events (work for both cross PartyB and PartyA takeover)
	event DeallocateForClearingHouse(address indexed subject, address[] parties, address[] allocationKeys, uint256[] amounts);
	event DistributeForClearingHouse(address indexed subject, address[] receivers, address[] allocationKeys, uint256[] amounts);
	/// @notice Exact net of all typed balance movements applied for one account/allocation group.
	/// @dev Positive means the account receives; negative means it pays. Component events for this group sum to `amount`.
	event ClearingHouseAccountSettlement(address indexed subject, address indexed account, address indexed allocationKey, int256 amount);
	/// @notice One explicit market or platform-fee contribution supplied by the Clearing House.
	/// @dev Positive values mean `account` receives; negative values mean it pays. Every value is final and already
	///      adjusted. Corrections use the original economic field with the opposite sign. Account/allocation totals
	///      use their matching funding, realized-PnL, or platform-fee balance-change reason; symbolId zero denotes
	///      a platform fee without market attribution.
	event ClearingHouseSettlementComponent(
		address indexed subject,
		address indexed account,
		uint256 indexed symbolId,
		address allocationKey,
		int256 realizedPnl,
		int256 funding,
		int256 platformFee
	);
	event LiquidatePendingPositionsForClearingHouse(address indexed subject, address[] counterparties, uint256[] liquidatedAmounts);
	event LiquidatePositionsForClearingHouse(
		address indexed subject,
		uint256[] quoteIds,
		uint256[] liquidatedAmounts,
		uint256[] closeIds,
		uint256[] prices
	);
	event CloseAffiliatePositions(address indexed affiliate, uint256[] quoteIds, uint256[] closedAmounts, uint256[] prices);

	// Auto-takeover event (emitted from ClearingHouseFacetImpl library)
	event AutoTakeoverPartyALiquidation(address indexed partyA, bytes liquidationId);

	// Settlement events
	event SettlePartyATakeover(address indexed partyA, bytes liquidationId);
	event SettleCrossPartyBLiquidation(address indexed partyB);

	// Liquidation escrow events
	event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);
	event DistributeFromLiquidationEscrow(address indexed partyA, address[] receivers, address[] allocationKeys, uint256[] amounts);

	// Soft liquidation event
	event SoftPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance);
}
