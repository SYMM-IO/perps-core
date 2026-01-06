// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ForceActionsFacetEvents } from "./ForceActionsFacetEvents.sol";
import { HighLowPriceSig, SettlementSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";

/// @title ForceActionsFacet Interface
/// @notice Defines the user-side (PartyA) force-action workflows that apply when
///         PartyB becomes unresponsive or when solvency logic requires the system
///         to close or cancel quotes/positions.
/// @dev The logic is implemented in ForceActionsFacet + ForceActionsFacetImpl.

interface IForceActionsFacet is ForceActionsFacetEvents {
	function forceCancelQuote(uint256 quoteId) external;

	function forceCancelCloseRequest(uint256 quoteId) external;

	function forceClosePosition(uint256 quoteId, HighLowPriceSig memory sig) external;

	/// @dev DEPRECATED: Use forceCloseAndSettlePositionsUnified instead
	function settleAndForceClosePosition(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices
	) external;

	/* 3-Step Force Close Functions (unified for both normal and master account modes) */

	function initializeForceClose(uint256 quoteId, HighLowPriceSig memory sig) external;

	function settleUpnlForForceClose(
		uint256 quoteId,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;

	function finalizeForceClose(uint256 quoteId) external;

	function forceCloseAndSettlePositionsUnified(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;
}
