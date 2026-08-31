// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";
import { SolverFeeEntry } from "../../storages/QuoteStorage.sol";
import { SingleUpnlSig, PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

/// @notice Party B execution with atomic, tagged solver fee charging. An empty fee list means no fee.
interface IPartyBExecutionFacet is IPartiesEvents {
	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) external;

	function lockAndOpenPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		SingleUpnlSig memory lockSig,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) external;

	function fillCloseRequest(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata solverFees
	) external;

	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 maxFillAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig,
		SolverFeeEntry[] calldata maxSolverFees
	) external returns (uint256 filledAmount);
}
