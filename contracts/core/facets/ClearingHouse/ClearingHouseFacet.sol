// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Pausable } from "../../utils/Pausable.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { IClearingHouseFacet } from "./IClearingHouseFacet.sol";
import { ClearingHouseFacetImpl } from "./ClearingHouseFacetImpl.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";

contract ClearingHouseFacet is Pausable, Accessibility, IClearingHouseFacet {
	/// @notice Initiates clearing house liquidation for a cross-margin PartyB.
	/// @param partyB The address of Party B.
	/// @param liquidationId Unique identifier for the liquidation event.
	/// @param upnl PartyB's unrealized profit and loss.
	/// @param timestamp Timestamp of the liquidation.
	function liquidateCrossPartyB(
		address partyB,
		bytes memory liquidationId,
		int256 upnl,
		uint256 timestamp
	) external whenNotLiquidationPaused notCrossLiquidatedPartyB(partyB) onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.liquidateCrossPartyB(partyB, liquidationId, upnl, timestamp);
		emit LiquidateCrossPartyB(msg.sender, partyB, liquidationId, upnl, timestamp);
	}

	/// @notice Takes over a stuck PartyA liquidation.
	/// @dev Can only be called when partyA is already being liquidated.
	///      Clears the disputed flag, liquidation fee, and liquidators array.
	///      Prevents normal liquidation functions from running.
	/// @param partyA The address of Party A.
	function takeoverPartyALiquidation(address partyA) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		bytes memory liquidationId = ClearingHouseFacetImpl.takeoverPartyALiquidation(partyA);
		emit TakeoverPartyALiquidation(partyA, liquidationId, block.timestamp);
	}

	/// @notice Deallocates funds from parties for clearing house liquidation.
	/// @dev Works for both cross PartyB liquidation and PartyA takeover.
	///      For cross PartyB: subject=partyB, parties=[partyB,...], allocationKeys=[partyA1,partyA2,...]
	///      For PartyA takeover: subject=partyA, parties=[partyA,partyB1,...], allocationKeys=[0,partyA,...]
	///      Special allocationKey address(1) pulls from partyAReimbursement.
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover).
	/// @param parties The parties to pull funds from.
	/// @param allocationKeys The allocation keys for each party.
	/// @param amounts The amounts to pull from each party.
	function deallocateForClearingHouse(
		address subject,
		address[] memory parties,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.deallocateForClearingHouse(subject, parties, allocationKeys, amounts);
		emit DeallocateForClearingHouse(subject, parties, allocationKeys, amounts);
	}

	/// @notice Distributes funds to receivers during clearing house liquidation.
	/// @dev Works for both cross PartyB liquidation and PartyA takeover.
	///      For partyB receivers: funds go to partyBAllocatedBalances[receiver][allocationKey]
	///        - allocationKey = address(0) for cross mode bucket
	///        - allocationKey = partyA address for isolated bucket
	///      For non-partyB receivers (partyAs, insurance funds, etc.): funds go to allocatedBalances[receiver]
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover).
	/// @param receivers The addresses to distribute to.
	/// @param allocationKeys The allocation keys for each receiver (used for partyB receivers).
	/// @param amounts The amounts to distribute.
	function distributeForClearingHouse(
		address subject,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.distributeForClearingHouse(subject, receivers, allocationKeys, amounts);
		emit DistributeForClearingHouse(subject, receivers, allocationKeys, amounts);
	}

	/// @notice Liquidates pending positions during clearing house liquidation.
	/// @dev Works for both cross PartyB liquidation and PartyA takeover.
	///      For cross PartyB: counterparties are the partyAs to process.
	///      For PartyA takeover: counterparties are ignored (processes all pending).
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover).
	/// @param counterparties The counterparties to process (only used for cross PartyB).
	function liquidatePendingPositionsForClearingHouse(
		address subject,
		address[] memory counterparties
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		uint256[] memory liquidatedAmounts = ClearingHouseFacetImpl.liquidatePendingPositionsForClearingHouse(subject, counterparties);
		emit LiquidatePendingPositionsForClearingHouse(subject, counterparties, liquidatedAmounts);
	}

	/// @notice Liquidates open positions during clearing house liquidation.
	/// @dev Works for both cross PartyB liquidation and PartyA takeover.
	///      Prices are provided directly without Muon signature verification.
	/// @param subject The party being liquidated (partyB for cross, partyA for takeover).
	/// @param quoteIds The quote IDs to liquidate.
	/// @param prices The prices to use for liquidation.
	function liquidatePositionsForClearingHouse(
		address subject,
		uint256[] memory quoteIds,
		uint256[] memory prices
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		(uint256[] memory liquidatedAmounts, uint256[] memory closeIds) = ClearingHouseFacetImpl.liquidatePositionsForClearingHouse(
			subject,
			quoteIds,
			prices
		);
		emit LiquidatePositionsForClearingHouse(subject, quoteIds, liquidatedAmounts, closeIds, prices);
	}

	/// @notice Settles the clearing house liquidation for PartyA takeover.
	/// @dev Only applicable to PartyA takeover flow. Clears all liquidation state.
	/// @param partyA The address of Party A.
	/// @param settledPartyBs PartyBs whose settlement states need cleanup
	///        (includes partyBs processed by normal flow before takeover).
	function settlePartyATakeover(
		address partyA,
		address[] memory settledPartyBs
	) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		bytes memory liquidationId = ClearingHouseFacetImpl.settlePartyATakeover(partyA, settledPartyBs);
		emit SettlePartyATakeover(partyA, liquidationId);
	}

	/// @notice Settles the clearing house liquidation for a cross PartyB.
	/// @dev Only applicable to cross PartyB liquidation flow.
	///      Requires all positions closed and all funds distributed.
	/// @param partyB The address of Party B.
	function settleCrossPartyBLiquidation(address partyB) external whenNotLiquidationPaused onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.settleCrossPartyBLiquidation(partyB);
		emit SettleCrossPartyBLiquidation(partyB);
	}

	/// @notice Distributes pending fees from the liquidation escrow created during LATE/OVERDUE PartyA liquidation settlement.
	/// @dev Supports both partyA-style addresses (allocatedBalances) and partyBs (partyBAllocatedBalances).
	/// @param partyA The partyA whose liquidation escrow to distribute from.
	/// @param receivers The addresses to distribute to.
	/// @param allocationKeys The allocation keys for each receiver (used for partyB receivers).
	/// @param amounts The amounts to distribute.
	function distributeFromLiquidationEscrow(
		address partyA,
		address[] memory receivers,
		address[] memory allocationKeys,
		uint256[] memory amounts
	) external onlyRole(LibAccessibility.CLEARING_HOUSE_ROLE) {
		ClearingHouseFacetImpl.distributeFromLiquidationEscrow(partyA, receivers, allocationKeys, amounts);
		emit DistributeFromLiquidationEscrow(partyA, receivers, allocationKeys, amounts);
	}

	/// @notice Applies a soft liquidation penalty to a Party B by deducting from their allocated and/or deposit balances.
	/// @param partyB The address of Party B being penalized.
	/// @param partyA The address of Party A associated with the penalty.
	/// @param penaltyFromAllocated The penalty amount to deduct from partyB's allocated balance.
	/// @param penaltyFromBalance The penalty amount to deduct from partyB's available balance.
	function softPartyBLiquidation(
		address partyB,
		address partyA,
		uint256 penaltyFromAllocated,
		uint256 penaltyFromBalance
	) external onlyRole(LibAccessibility.SOFT_LIQUIDATOR_ROLE) {
		ClearingHouseFacetImpl.softPartyBLiquidation(partyB, partyA, penaltyFromAllocated, penaltyFromBalance);
		emit SoftPartyBLiquidation(partyB, partyA, penaltyFromAllocated, penaltyFromBalance);
	}
}
