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
	 * @notice Performs ADL close for a quote on a symbol
	 * @dev Uses ADLFacetImpl to handle balance checks, nonce bumps, and quote status/closeId management.
	 * @param quoteId Quote to ADL close
	 * @param amount Amounts to close per quote (token decimals).
	 * @param price Execution price per quote.
	 */
	function adlClose(uint256 quoteId, uint256 amount, uint256 price) external whenNotPartyBActionsPaused returns (uint256) {
		uint256 closedAmount = ADLFacetImpl.adlClose(quoteId, amount, price);
		emit LibPartiesEvents.ADLClose(quoteId, amount, price, closedAmount);
		return closedAmount;
	}
}
