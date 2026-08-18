// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IClearingHouseFacetEvents } from "./IClearingHouseFacetEvents.sol";

/// @notice One signed economic contribution supplied by the Clearing House.
/// @dev Values are from `account`'s perspective: positive means the account receives and negative means it pays.
///      Every value is final after any Clearing House deficit, haircut, dispute, or cap. Funding and realized PnL
///      require a real symbolId; platform fees may use symbolId zero when they are not market-attributed.
///      Each field is applied with its matching balance-change reason, so corrections use the original economic
///      class with the opposite sign instead of an unclassified adjustment. Close solver fees are
///      quote-level inputs to liquidatePositionsForClearingHouse and use the normal close-fee accounting path.
///      Entries must be strictly ordered by account, allocationKey, and symbolId.
struct ClearingHouseSettlement {
	address account;
	address allocationKey;
	uint256 symbolId;
	int256 realizedPnl;
	int256 funding;
	int256 platformFee;
}

interface IClearingHouseFacet is IClearingHouseFacetEvents {
	// Initialization functions (different for each flow)
	function liquidateCrossPartyB(address partyB, bytes memory liquidationId, int256 upnl, uint256 timestamp) external;

	function takeoverPartyALiquidation(address partyA) external;

	// Unified clearing house functions (work for both flows)
	function deallocateForClearingHouse(
		address subject,
		address[] memory parties,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external;

	function distributeForClearingHouse(
		address subject,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external;

	/// @notice Applies explicit signed market settlement components during a Clearing House liquidation.
	/// @dev Components sharing an account and allocation key are netted once per economic class. Corrections use
	///      the original field with the opposite sign. Their typed
	///      balance changes sum to the account settlement event. The array must use the canonical order above.
	function applyClearingHouseSettlement(address subject, ClearingHouseSettlement[] memory settlements) external;

	function liquidatePendingPositionsForClearingHouse(address subject, address[] memory counterparties) external;

	function liquidatePositionsForClearingHouse(
		address subject,
		uint256[] memory quoteIds,
		uint256[] memory prices,
		uint256[] memory closeSolverFees
	) external;

	function closeAffiliatePositions(address affiliate, uint256[] memory quoteIds, uint256[] memory prices) external;

	// Settlement
	function settlePartyATakeover(address partyA, address[] memory settledPartyBs) external;
	function settleCrossPartyBLiquidation(address partyB, address[] memory settledPartyAs, bool finalize) external;

	// Liquidation escrow distribution
	function distributeFromLiquidationEscrow(
		address partyA,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external;

	// Soft liquidation
	function softPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance) external;
}
