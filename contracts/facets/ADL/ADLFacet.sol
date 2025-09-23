// contracts/facets/ADL/ADLFacet.sol
// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./ADLFacetImpl.sol";
import "./IADLFacet.sol";
import "../../utils/Accessibility.sol";
import "../../utils/Pausable.sol";
import "../../storages/QuoteStorage.sol";

contract ADLFacet is Accessibility, Pausable, IADLFacet {
	/**
	 * @notice Allows PartyB to close multiple positions unilaterally when ADL is enabled
	 * @param quoteIds Array of quote IDs to close
	 * @param filledAmounts Array of amounts to close for each quote
	 * @param closedPrices Array of prices at which PartyB wants to close each position
	 * @param upnlSig Muon signature for solvency checks
	 */
	function adlClosePositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external whenNotPartyBActionsPaused onlyPartyB {
		QuoteStatus[] memory statuses = ADLFacetImpl.adlClosePositions(quoteIds, filledAmounts, closedPrices, upnlSig);

		Quote storage firstQuote = QuoteStorage.layout().quotes[quoteIds[0]];
		for (uint256 i = 0; i < quoteIds.length; i++) {
			emit ADLClosePosition(quoteIds[i], firstQuote.partyA, firstQuote.partyB, filledAmounts[i], closedPrices[i], statuses[i]);
		}
	}
}
