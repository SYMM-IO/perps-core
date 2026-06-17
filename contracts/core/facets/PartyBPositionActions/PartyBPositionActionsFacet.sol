// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PartyBPositionActionsFacetImpl } from "./PartyBPositionActionsFacetImpl.sol";
import { IPartyBPositionActionsFacet } from "./IPartyBPositionActionsFacet.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { QuoteStorage, Quote, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";
import { LibSendQuoteEvents } from "../../libraries/LibSendQuoteEvents.sol";
import { LibSolverFee } from "../../libraries/LibSolverFee.sol";
import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";

contract PartyBPositionActionsFacet is Accessibility, Pausable, IPartyBPositionActionsFacet {
	/// @notice Opens a position for the specified quote. The opened position's size can't be excessively small or large.
	/// @param quoteId The ID of the quote for which the position is opened.
	/// @param filledAmount PartyB has the option to open the position with either the full amount requested by the user or a specific fraction of it
	/// @param openedPrice The opened price for the position.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	function openPosition(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 openedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) external whenNotPartyBOpenPositionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		uint256 newId = PartyBPositionActionsFacetImpl.openPosition(quoteId, filledAmount, openedPrice, upnlSig);
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		LibPartiesEvents.emitOpenPosition(quote, quoteId, filledAmount, openedPrice);
		if (newId != 0) {
			Quote storage newQuote = QuoteStorage.layout().quotes[newId];
			if (newQuote.quoteStatus == QuoteStatus.PENDING) {
				LibSendQuoteEvents.emitSendQuoteEvents(
					LibSendQuoteEvents.SendQuoteEventParams({
						partyA: newQuote.partyA,
						quoteId: newQuote.id,
						partyBsWhiteList: newQuote.partyBsWhiteList,
						symbolId: newQuote.symbolId,
						positionType: newQuote.positionType,
						orderType: newQuote.orderType,
						price: newQuote.requestedOpenPrice,
						marketPrice: newQuote.marketPrice,
						quantity: newQuote.quantity,
						cva: newQuote.lockedValues.cva,
						lf: newQuote.lockedValues.lf,
						partyAmm: newQuote.lockedValues.partyAmm,
						partyBmm: newQuote.lockedValues.partyBmm,
						tradingFee: newQuote.tradingFee,
						deadline: newQuote.deadline,
						affiliate: newQuote.affiliate,
						solverFeeCaps: LibSolverFee.caps(QuoteStorage.layout().solverFeeStates[newId]),
						data: newQuote.data
					})
				);
			} else if (newQuote.quoteStatus == QuoteStatus.CANCELED) {
				emit AcceptCancelRequest(newQuote.id, QuoteStatus.CANCELED);
			}
		}
	}

	/// @notice Fills the close request for the specified quote.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param filledAmount The filled amount for the close request. PartyB can fill LIMIT requests in multiple steps
	///                     and each within a different price but market requests should be filled all at once.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	function fillCloseRequest(
		uint256 quoteId,
		uint256 filledAmount,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		PartyBPositionActionsFacetImpl.fillCloseRequest(quoteId, filledAmount, closedPrice, upnlSig);
		LibPartiesEvents.emitFillCloseRequest(quoteLayout, quote, quoteId, filledAmount, closedPrice);
	}

	/// @notice Accepts a cancel close request for the specified quote.
	/// @param quoteId The ID of the quote for which the cancel close request is accepted.
	function acceptCancelCloseRequest(uint256 quoteId) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		PartyBPositionActionsFacetImpl.acceptCancelCloseRequest(quoteId);
		emit AcceptCancelCloseRequest(quoteId, QuoteStatus.OPENED, QuoteStorage.layout().closeIds[quoteId]);
	}

	/// @notice Fills a close request up to the maximum amount that keeps PartyA at the edge of liquidation.
	///         Use this when the standard fillCloseRequest would revert due to PartyA insolvency.
	///         This calculates and closes only the amount that brings PartyA to approximately 0 available balance.
	///         Reverts if even a full close keeps PartyA insolvent.
	/// @dev IMPORTANT BACKWARD-COMPATIBILITY WARNING:
	///      This legacy method accounts for the protocol closeFee only. It does NOT reserve balance for solver
	///      fees charged through the solver-fee API. If a solver fee will be charged for this close, call
	///      the fee-aware PartyBSolverFeeActionsFacet.fillCloseRequestToLiquidation overload instead.
	/// @param quoteId The ID of the quote for which the close request is filled.
	/// @param closedPrice The closed price for the close request.
	/// @param upnlSig The Muon signature containing PairUpnlAndPriceSig data.
	/// @return filledAmount The actual amount that was filled.
	function fillCloseRequestToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		PairUpnlAndPriceSig memory upnlSig
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) returns (uint256 filledAmount) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		filledAmount = PartyBPositionActionsFacetImpl.fillCloseRequestToLiquidation(quoteId, closedPrice, upnlSig);
		LibPartiesEvents.emitFillCloseRequest(quoteLayout, quote, quoteId, filledAmount, closedPrice);
	}
}
