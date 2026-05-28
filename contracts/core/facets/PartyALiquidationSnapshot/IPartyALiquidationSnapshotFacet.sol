// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyALiquidationEvents } from "../../interfaces/IPartyALiquidationEvents.sol";
import { LiquidationSnapshotSig } from "../../storages/MuonStorage.sol";

interface IPartyALiquidationSnapshotFacet is IPartyALiquidationEvents {
	function liquidatePartyAWithSnapshot(address partyA, LiquidationSnapshotSig memory liquidationSig) external;

	function setSymbolsPriceWithSnapshot(address partyA, LiquidationSnapshotSig memory liquidationSig) external;

	function singleStepLiquidatePartyAWithSnapshot(
		address partyA,
		LiquidationSnapshotSig memory liquidationSig,
		uint256[] memory quoteIds,
		address[] memory partyBs
	) external;

	function liquidatePendingPositionsPartyAWithSnapshot(address partyA) external;

	function liquidatePositionsPartyAWithSnapshot(address partyA, uint256[] memory quoteIds) external;

	function settlePartyALiquidationWithSnapshot(address partyA, address[] memory partyBs) external;

	function resolveLiquidationDisputeWithSnapshot(address partyA, address[] memory partyBs, int256[] memory amounts, bool disputed) external;
}
