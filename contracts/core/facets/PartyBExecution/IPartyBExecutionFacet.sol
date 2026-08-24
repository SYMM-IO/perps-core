// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";
import { SingleUpnlSig, PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

/// @notice The fee-aware solver execution interface: every trade action a solver performs, with the
///         solver rate fee charged atomically. Pass solverFee = 0 for fee-less execution.
interface IPartyBExecutionFacet is IPartiesEvents {
	function openPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice, PairUpnlAndPriceSig memory upnlSig, uint256 solverFee) external;

	function lockAndOpenPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		SingleUpnlSig memory lockSig,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) external;

	function fillCloseRequest(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) external;

	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 maxQuantity,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		uint256 solverFee
	) external returns (uint256 filledAmount);
}
