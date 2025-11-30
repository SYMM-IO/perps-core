// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./PartyBBatchActionsFacetImpl.sol";
import "../../utils/Accessibility.sol";
import "../../utils/Pausable.sol";
import "./IPartyBBatchActionsFacet.sol";

contract PartyBBatchActionsFacet is Accessibility, Pausable, IPartyBBatchActionsFacet {
	/**
	 * @notice Opens positions for the specified quotes. The opened position's size can't be excessively small or large.
	 * 			If it's like 99/100, the leftover will be a minuscule quote that falls below the minimum acceptable quote value.
	 * 			Conversely, the position might be so small that it also falls beneath the minimum value.
	 * 			Also, the remaining open portion of the position cannot fall below the minimum acceptable quote value for that particular symbol.
	 * @param quoteIds The ID of the quotes for which the positions is opened.
	 * @param filledAmounts PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it
	 * @param openedPrices The opened price for the positions.
	 * @param upnlSig The Muon signature containing PairUpnlAndPricesSig data.
	 */
	function openPositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory openedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external whenNotPartyBActionsPaused {
//		uint256[] memory newIds = PartyBBatchActionsFacetImpl.openPositions(quoteIds, filledAmounts, openedPrices, upnlSig);
//		for (uint256 i = 0; i < newIds.length; i++) {
//			Quote storage quote = QuoteStorage.layout().quotes[quoteIds[i]];
//			emit OpenPosition(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], openedPrices[i]);
//			emit OpenPosition(quoteIds[i], quote.partyA, quote.partyB, filledAmounts[i], openedPrices[i], quote.lockedValues);
//			if (newIds[i] != 0) {
//				Quote storage newQuote = QuoteStorage.layout().quotes[newIds[i]];
//				if (newQuote.quoteStatus == QuoteStatus.PENDING) {
//					emit SendQuote(
//						newQuote.partyA,
//						newQuote.id,
//						newQuote.partyBsWhiteList,
//						newQuote.symbolId,
//						newQuote.positionType,
//						newQuote.orderType,
//						newQuote.requestedOpenPrice,
//						newQuote.marketPrice,
//						newQuote.quantity,
//						newQuote.lockedValues.cva,
//						newQuote.lockedValues.lf,
//						newQuote.lockedValues.partyAmm,
//						newQuote.lockedValues.partyBmm,
//						newQuote.tradingFee,
//						newQuote.deadline
//					);
//				} else if (newQuote.quoteStatus == QuoteStatus.CANCELED) {
//					emit AcceptCancelRequest(newQuote.id, QuoteStatus.CANCELED);
//				}
//			}
//		}
	}

	/**
	 * @notice Fills the close request for the specified quotes.
	 * @param quoteIds The ID of the quotes for which the close request is filled.
	 * @param filledAmounts The filled amount for the close requests. PartyB can fill the LIMIT requests in multiple steps
	 * 						and each within a different price but the market requests should be filled all at once.
	 * @param closedPrices The closed price for the close requests.
	 * @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	 */
	function fillCloseRequests(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external whenNotPartyBActionsPaused {
//		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
//		(QuoteStatus[] memory quoteStatuses, uint256[] memory closeIds) = PartyBBatchActionsFacetImpl.closePositions(
//			quoteIds,
//			filledAmounts,
//			closedPrices,
//			upnlSig,
//			false
//		);
//		for (uint256 i = 0; i < quoteIds.length; i++) {
//			Quote storage quote = quoteLayout.quotes[quoteIds[i]];
//			emit FillCloseRequest(
//				quoteIds[i],
//				quote.partyA,
//				quote.partyB,
//				filledAmounts[i],
//				closedPrices[i],
//				quoteStatuses[i],
//				closeIds[i]
//			);
//            emit FillCloseRequest(
//				quoteIds[i],
//				quote.partyA,
//				quote.partyB,
//				filledAmounts[i],
//				closedPrices[i],
//				quoteStatuses[i],
//				closeIds[i],
//        		quote.lockedValues
//			);
//		}
	}

	function adlClosePositions(
		uint256[] memory quoteIds,
		uint256[] memory filledAmounts,
		uint256[] memory closedPrices,
		PairUpnlAndPricesSig memory upnlSig
	) external whenNotPartyBActionsPaused {
//		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
//		(QuoteStatus[] memory quoteStatuses,) = PartyBBatchActionsFacetImpl.closePositions(
//			quoteIds,
//			filledAmounts,
//			closedPrices,
//			upnlSig,
//			true
//		);
//		Quote storage firstQuote = quoteLayout.quotes[quoteIds[0]];
//		for (uint256 i = 0; i < quoteIds.length; i++) {
//			emit AdlClosePositions(
//				quoteIds[i],
//				firstQuote.partyA,
//				firstQuote.partyB,
//				filledAmounts[i],
//				closedPrices[i],
//				quoteStatuses[i]
//			);
//		}
	}
}
