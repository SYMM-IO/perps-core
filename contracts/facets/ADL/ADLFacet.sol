// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ADLFacetImpl } from "./ADLFacetImpl.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IADLFacet } from "./IADLFacet.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { LibPartyBBatchEvents } from "../../libraries/PartysEvents.sol";

contract ADLFacet is Accessibility, Pausable, IADLFacet {
	/**
	 * @notice Performs ADL closes for quotes on the same symbol, emitting fill events per quote.
	 * @dev Uses ADLFacetImpl to handle balance checks, nonce bumps, and quote status/closeId management.
	 * @param quoteIds Quotes to ADL close (must share partyA/partyB/symbol).
	 * @param amounts Amounts to close per quote (token decimals).
	 * @param prices Execution prices per quote.
	 */
	function adlClose(uint256[] calldata quoteIds, uint256[] calldata amounts, uint256[] calldata prices) external whenNotPartyBActionsPaused returns (uint256) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256 len = quoteIds.length;

		(uint256[] memory filledAmounts, uint256 closedAmount, uint256[] memory closeIds) = ADLFacetImpl.adlClose(quoteIds, amounts, prices);

		for (uint256 i = 0; i < len; ) {
			uint256 filledAmount = filledAmounts[i];
			if (filledAmount > 0) {
				uint256 quoteId = quoteIds[i];
				Quote storage quote = quoteLayout.quotes[quoteId];
				emit FillCloseRequest(quoteId, quote.partyA, quote.partyB, filledAmount, prices[i], quote.quoteStatus, closeIds[i]);
			}
			unchecked {
				++i;
			}
		}
		emit LibPartyBBatchEvents.ADLClose(quoteIds, amounts, prices, closedAmount);
		return closedAmount;
	}
}
