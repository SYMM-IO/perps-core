// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ADLFacetImpl } from "./ADLFacetImpl.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IADLFacet } from "./IADLFacet.sol";
import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";

contract ADLFacet is Accessibility, Pausable, IADLFacet {
	/**
	 * @notice Performs ADL closes for quotes on the same symbol, emitting fill events per quote.
	 * @dev Uses ADLFacetImpl to handle balance checks, nonce bumps, and quote status/closeId management.
	 * @param quoteIds Quotes to ADL close (must share partyA/partyB/symbol).
	 * @param amounts Amounts to close per quote (token decimals).
	 * @param prices Execution prices per quote.
	 */
	function adlClose(uint256[] calldata quoteIds, uint256[] calldata amounts, uint256[] calldata prices) external whenNotPartyBActionsPaused returns (uint256) {
		uint256 closedAmount = ADLFacetImpl.adlClose(quoteIds, amounts, prices);
		emit LibPartiesEvents.ADLClose(quoteIds, amounts, prices, closedAmount);
		return closedAmount;
	}
}
