// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";
import { SolverFeeType } from "../../storages/QuoteStorage.sol";
import { SingleUpnlSig, PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

/// @notice Party B convenience execution and standalone solver fee charging.
interface IPartyBExecutionFacet is IPartiesEvents {
	function lockAndOpenPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		SingleUpnlSig memory lockSig,
		PairUpnlAndPriceSig memory upnlSig
	) external;

	function chargeSolverFee(uint256 quoteId, SolverFeeType feeType, uint256 amount, bytes calldata tag) external;
}
