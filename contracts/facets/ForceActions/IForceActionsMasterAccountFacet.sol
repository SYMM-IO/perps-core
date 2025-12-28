// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ForceActionsMasterAccountFacetEvents } from "./ForceActionsMasterAccountFacetEvents.sol";
import { HighLowPriceSig, MasterAccountSettlementSig } from "../../storages/MuonStorage.sol";

/// @title ForceActionsMasterAccountFacet Interface
/// @notice Defines the user-side (PartyA) force-action workflows for master account mode
///         that apply when PartyB becomes unresponsive or when solvency logic requires
///         the system to close positions.
/// @dev The logic is implemented in ForceActionsMasterAccountFacet + ForceActionsFacetImpl.

interface IForceActionsMasterAccountFacet is ForceActionsMasterAccountFacetEvents {
	function initializeMasterAccountForceClose(uint256 quoteId, HighLowPriceSig memory sig) external;

	function settleUpnlMasterAccount(
		uint256 forceCloseQuoteId,
		MasterAccountSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;

	function finalizeMasterAccountForceClose(uint256 quoteId) external;

	function forceCloseAndSettlePositionsMasterAccount(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		MasterAccountSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;
}
