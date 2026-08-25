// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBPositionActionsEvents } from "./IPartyBPositionActionsEvents.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

interface IPartyBPositionActionsFacet is IPartyBPositionActionsEvents {
	function openPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice, PairUpnlAndPriceSig memory upnlSig) external;

	function fillCloseRequest(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, PairUpnlAndPriceSig memory upnlSig) external;

	/// @notice Backward-compatible close-to-liquidation helper.
	/// @dev IMPORTANT: This legacy method reserves room only for the protocol closeFee. It does not reserve room
	///      for solver fees charged through the solver-fee API. If a solver fee will be charged for the close,
	///      use the fee-aware PartyBExecutionFacet.fillCloseRequestToLiquidation overload instead. Supports LIMIT
	///      and MARKET_BEST_EFFORT close requests; ordinary MARKET requests remain full-fill-only.
	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) external returns (uint256 filledAmount);

	function acceptCancelCloseRequest(uint256 quoteId) external;
}
