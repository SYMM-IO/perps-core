// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";

interface IPartyBLiquidationEvents is IPartiesEvents {
	event LiquidatePositionsPartyB(
		address liquidator,
		address partyB,
		address partyA,
		uint256[] quoteIds,
		uint256[] liquidatedAmounts,
		uint256[] closeIds
	);
	event LiquidatePositionsPartyB(
		address liquidator,
		address partyB,
		address partyA,
		uint256[] quoteIds,
		uint256[] liquidatedAmounts,
		uint256[] closeIds,
		uint256[] averageClosedPrices
	);
	event FullyLiquidatedPartyB(address partyB, address partyA);
}
