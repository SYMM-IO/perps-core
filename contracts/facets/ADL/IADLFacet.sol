// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IPartyBBatchActionsEvents } from "../PartyBBatchActions/IPartyBBatchActionsEvents.sol";
import { ADLReason } from "../../libraries/LibPartiesEvents.sol";

interface IADLFacet is IPartyBBatchActionsEvents {
	event ADLSkip(uint256 quoteId, address partyA, address partyB, ADLReason reason, int256 requiredFundingFee);
	event ADLClose(uint256[] quoteIds, uint256[] amounts, uint256[] prices, uint256 closedAmount);

	function adlClose(uint256[] calldata quoteIds, uint256[] calldata amounts, uint256[] calldata prices) external returns (uint256);
}
