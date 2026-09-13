// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyALiquidationEvents } from "../../interfaces/IPartyALiquidationEvents.sol";
import { LiquidationSig, DeferredLiquidationSig } from "../../storages/MuonStorage.sol";

interface IPartyALiquidationFacet is IPartyALiquidationEvents {
	function liquidatePartyA(address partyA, LiquidationSig memory liquidationSig) external;

	/// @dev During an open restatement, symbol prices use venue units and the signature must strictly postdate the window.
	function setSymbolsPrice(address partyA, LiquidationSig memory liquidationSig) external;

	function deferredLiquidatePartyA(address partyA, DeferredLiquidationSig memory liquidationSig) external;

	/// @dev During an open restatement, symbol prices use venue units and the signature must strictly postdate the window.
	function deferredSetSymbolsPrice(address partyA, DeferredLiquidationSig memory liquidationSig) external;

	function liquidatePendingPositionsPartyA(address partyA) external;

	/// @dev Converts a stored venue-basis liquidation price per quote while a restatement window is open.
	function liquidatePositionsPartyA(address partyA, uint256[] memory quoteIds) external;

	function settlePartyALiquidation(address partyA, address[] memory partyBs) external;

	function resolveLiquidationDispute(address partyA, address[] memory partyBs, int256[] memory amounts, bool disputed) external;
}
