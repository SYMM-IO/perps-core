// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBBatchActionsEvents } from "./IPartyBBatchActionsEvents.sol";
import { PairUpnlAndPricesSig } from "../../storages/MuonStorage.sol";

interface IPartyBBatchActionsFacet is IPartyBBatchActionsEvents {
	function openPositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory openedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external;

	function fillCloseRequests(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external;

	function adlClose(uint256[] calldata quoteIds, uint256 ratio, uint256 price) external returns (uint256);
}
