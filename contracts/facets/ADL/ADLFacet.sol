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
	 * @param ratio Portion of the open amount to close (1e18 = 100%).
	 * @param price Execution price for the ADL close.
	 */
	function adlClose(uint256[] calldata quoteIds, uint256 ratio, uint256 price) external whenNotPartyBActionsPaused returns (uint256) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256 len = quoteIds.length;

		(uint256[] memory filledAmounts, uint256 closedAmount, uint256[] memory closeIds) = ADLFacetImpl.adlClose(
			quoteIds,
			ratio,
			price
		);

		for (uint256 i = 0; i < len; ) {
			uint256 filledAmount = filledAmounts[i];
			if (filledAmount > 0) {
				uint256 quoteId = quoteIds[i];
				Quote storage quote = quoteLayout.quotes[quoteId];
				uint256 closeIdToUse = closeIds[i] == 0 ? quoteLayout.closeIds[quoteId] : closeIds[i];

				emit FillCloseRequest(quoteId, quote.partyA, quote.partyB, filledAmount, price, quote.quoteStatus, closeIdToUse);
			}
			unchecked {
				++i;
			}
		}
		emit LibPartyBBatchEvents.ADLClose(quoteIds, ratio, price, closedAmount);
		return closedAmount;
	}
}
