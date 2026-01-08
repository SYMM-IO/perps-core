// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ForceActionsFacetEvents } from "./ForceActionsFacetEvents.sol";
import { HighLowPriceSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";

/// @title ForceCloseStepsFacet Interface
/// @notice Defines the 3-step force close workflow for both normal and master account modes.
/// @dev The logic is implemented in ForceCloseStepsFacet + ForceCloseStepsImpl.

interface IForceCloseStepsFacet is ForceActionsFacetEvents {
	/**
	 * @notice Initializes the 3-step force close flow (works for both normal and master account modes).
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 */
	function initializeForceClose(uint256 quoteId, HighLowPriceSig memory sig) external;

	/**
	 * @notice Settles uPNL for the 3-step force close using unified settlement.
	 * @param quoteId The ID of the quote for the force close workflow.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function settleUpnlForForceClose(
		uint256 quoteId,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;

	/**
	 * @notice Finalizes the 3-step force close flow (handles both normal and master account modes).
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 */
	function finalizeForceClose(uint256 quoteId) external;

	/**
	 * @notice Refreshes the force-close snapshot (uPNL/currentPrice) using a fresh HighLowPriceSig.
	 * @param quoteId The ID of the quote for the force close workflow.
	 * @param sig Fresh Muon signature (uPNLs + currentPrice).
	 */
	function refreshForceCloseSnapshot(uint256 quoteId, HighLowPriceSig memory sig) external;

	/**
	 * @notice Finalizes the 3-step force close flow using a fresh HighLowPriceSig to refresh uPNL/currentPrice.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig Fresh Muon signature (uPNLs + currentPrice) to use for solvency checks and liquidation calculations.
	 */
	function finalizeForceClose(uint256 quoteId, HighLowPriceSig memory sig) external;

	/**
	 * @notice Initializes, settles uPNL, and finalizes the force close in a single transaction.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function forceCloseAndSettlePositionsUnified(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;
}
