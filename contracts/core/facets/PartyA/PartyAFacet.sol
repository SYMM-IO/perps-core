// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PartyAFacetImpl } from "./PartyAFacetImpl.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IPartyAFacet } from "./IPartyAFacet.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibSendQuoteEvents } from "../../libraries/LibSendQuoteEvents.sol";
import { QuoteStorage, Quote, QuoteStatus, PositionType, OrderType, SolverFeeCaps } from "../../storages/QuoteStorage.sol";
import { SingleUpnlAndPriceSig } from "../../storages/MuonStorage.sol";

contract PartyAFacet is Accessibility, Pausable, IPartyAFacet {
	/// @notice Send a Quote to the protocol. The quote status will be pending.
	/// @param partyBsWhiteList List of party B addresses allowed to act on this quote.
	/// @param symbolId Each symbol within the system possesses a unique identifier, for instance, BTCUSDT carries its own distinct ID
	/// @param positionType Can be SHORT or LONG (0 or 1)
	/// @param orderType Can be LIMIT or MARKET (0 or 1)
	/// @param price For limit orders, this is the user-requested price for the position, and for market orders, this acts as the price threshold
	/// 			that the user is willing to open a position
	/// @param quantity Size of the position
	/// @param cva The Credit Valuation Adjustment value -- penalty the liquidated side pays to the other
	/// @param lf Liquidation Fee paid to the liquidator user
	/// @param partyAmm The partyA Maintenance Margin value behind the position
	/// @param partyBmm The partyB Maintenance Margin value behind the position
	/// @param maxFundingRate Unused, kept for backward compatibility. Funding caps are postponed to a later version.
	/// @param deadline Expiration timestamp for the quote request
	/// @param affiliate The affiliate of this quote
	/// @param upnlSig The Muon signature for user upnl and symbol price
	function sendQuoteWithAffiliate(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 maxFundingRate,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig
	)
		external
		whenInstantModeIsNotActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
		notLiquidatedPartyA(LibSigner.getSigner())
		notSuspended(LibSigner.getSigner())
		returns (uint256 quoteId)
	{
		maxFundingRate; // silence unused variable warning
		PartyAFacetImpl.sendQuote(
			partyBsWhiteList,
			symbolId,
			positionType,
			orderType,
			price,
			quantity,
			cva,
			lf,
			partyAmm,
			partyBmm,
			deadline,
			affiliate,
			upnlSig,
			"",
			SolverFeeCaps({ openRateCap: 0, closeRateCap: 0 })
		);

		quoteId = QuoteStorage.layout().lastId;
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		LibSendQuoteEvents.emitSendQuoteEvents(
			LibSendQuoteEvents.SendQuoteEventParams({
				partyA: LibSigner.getSigner(),
				quoteId: quoteId,
				partyBsWhiteList: partyBsWhiteList,
				symbolId: symbolId,
				positionType: positionType,
				orderType: orderType,
				price: price,
				marketPrice: upnlSig.price,
				quantity: quantity,
				cva: quote.lockedValues.cva,
				lf: quote.lockedValues.lf,
				partyAmm: quote.lockedValues.partyAmm,
				partyBmm: quote.lockedValues.partyBmm,
				tradingFee: quote.tradingFee,
				deadline: deadline,
				affiliate: affiliate,
				solverFeeCaps: SolverFeeCaps({ openRateCap: 0, closeRateCap: 0 }),
				data: ""
			})
		);
	}

	/// @notice Send a Quote to the protocol with custom data. The quote status will be pending.
	/// @param partyBsWhiteList List of party B addresses allowed to act on this quote.
	/// @param symbolId Each symbol within the system possesses a unique identifier, for instance, BTCUSDT carries its own distinct ID
	/// @param positionType Can be SHORT or LONG (0 or 1)
	/// @param orderType Can be LIMIT or MARKET (0 or 1)
	/// @param price For limit orders, this is the user-requested price for the position, and for market orders, this acts as the price threshold
	/// 			that the user is willing to open a position
	/// @param quantity Size of the position
	/// @param cva The Credit Valuation Adjustment value -- penalty the liquidated side pays to the other
	/// @param lf Liquidation Fee paid to the liquidator user
	/// @param partyAmm The partyA Maintenance Margin value behind the position
	/// @param partyBmm The partyB Maintenance Margin value behind the position
	/// @param deadline Expiration timestamp for the quote request
	/// @param affiliate The affiliate of this quote
	/// @param upnlSig The Muon signature for user upnl and symbol price
	/// @param data Optional custom data attached to the quote
	function sendQuoteWithAffiliateAndData(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig,
		bytes memory data
	)
		external
		whenInstantModeIsNotActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
		notLiquidatedPartyA(LibSigner.getSigner())
		notSuspended(LibSigner.getSigner())
		returns (uint256 quoteId)
	{
		PartyAFacetImpl.sendQuote(
			partyBsWhiteList,
			symbolId,
			positionType,
			orderType,
			price,
			quantity,
			cva,
			lf,
			partyAmm,
			partyBmm,
			deadline,
			affiliate,
			upnlSig,
			data,
			SolverFeeCaps({ openRateCap: 0, closeRateCap: 0 })
		);

		quoteId = QuoteStorage.layout().lastId;
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		LibSendQuoteEvents.emitSendQuoteEvents(
			LibSendQuoteEvents.SendQuoteEventParams({
				partyA: LibSigner.getSigner(),
				quoteId: quoteId,
				partyBsWhiteList: partyBsWhiteList,
				symbolId: symbolId,
				positionType: positionType,
				orderType: orderType,
				price: price,
				marketPrice: upnlSig.price,
				quantity: quantity,
				cva: quote.lockedValues.cva,
				lf: quote.lockedValues.lf,
				partyAmm: quote.lockedValues.partyAmm,
				partyBmm: quote.lockedValues.partyBmm,
				tradingFee: quote.tradingFee,
				deadline: deadline,
				affiliate: affiliate,
				solverFeeCaps: SolverFeeCaps({ openRateCap: 0, closeRateCap: 0 }),
				data: data
			})
		);
	}

	/// @notice Send a Quote to the protocol with custom data and immutable solver fee caps. The quote status will be pending.
	/// @param partyBsWhiteList List of party B addresses allowed to act on this quote.
	/// @param symbolId Each symbol within the system possesses a unique identifier, for instance, BTCUSDT carries its own distinct ID
	/// @param positionType Can be SHORT or LONG (0 or 1)
	/// @param orderType Can be LIMIT or MARKET (0 or 1)
	/// @param price For limit orders, this is the user-requested price for the position, and for market orders, this acts as the price threshold
	/// 			that the user is willing to open a position
	/// @param quantity Size of the position
	/// @param cva The Credit Valuation Adjustment value -- penalty the liquidated side pays to the other
	/// @param lf Liquidation Fee paid to the liquidator user
	/// @param partyAmm The partyA Maintenance Margin value behind the position
	/// @param partyBmm The partyB Maintenance Margin value behind the position
	/// @param deadline Expiration timestamp for the quote request
	/// @param affiliate The affiliate of this quote
	/// @param upnlSig The Muon signature for user upnl and symbol price
	/// @param data Optional custom data attached to the quote
	/// @param solverFeeCaps User-approved solver fee caps for the quote
	function sendQuote(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig,
		bytes memory data,
		SolverFeeCaps memory solverFeeCaps
	)
		external
		whenInstantModeIsNotActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
		notLiquidatedPartyA(LibSigner.getSigner())
		notSuspended(LibSigner.getSigner())
		returns (uint256 quoteId)
	{
		PartyAFacetImpl.sendQuote(
			partyBsWhiteList,
			symbolId,
			positionType,
			orderType,
			price,
			quantity,
			cva,
			lf,
			partyAmm,
			partyBmm,
			deadline,
			affiliate,
			upnlSig,
			data,
			solverFeeCaps
		);

		quoteId = QuoteStorage.layout().lastId;
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		LibSendQuoteEvents.emitSendQuoteEvents(
			LibSendQuoteEvents.SendQuoteEventParams({
				partyA: LibSigner.getSigner(),
				quoteId: quoteId,
				partyBsWhiteList: partyBsWhiteList,
				symbolId: symbolId,
				positionType: positionType,
				orderType: orderType,
				price: price,
				marketPrice: upnlSig.price,
				quantity: quantity,
				cva: quote.lockedValues.cva,
				lf: quote.lockedValues.lf,
				partyAmm: quote.lockedValues.partyAmm,
				partyBmm: quote.lockedValues.partyBmm,
				tradingFee: quote.tradingFee,
				deadline: deadline,
				affiliate: affiliate,
				solverFeeCaps: solverFeeCaps,
				data: data
			})
		);
	}

	/// @notice Expires the specified quotes or close requests that have passed their deadline.
	/// @param expiredQuoteIds An array of IDs of the quotes to be expired.
	function expireQuote(uint256[] memory expiredQuoteIds) external whenNotPartyAActionsPaused {
		QuoteStatus result;
		for (uint256 i; i < expiredQuoteIds.length; i++) {
			result = LibQuoteClose.expireQuote(expiredQuoteIds[i]);
			if (result == QuoteStatus.OPENED) {
				emit ExpireQuoteClose(result, expiredQuoteIds[i], QuoteStorage.layout().closeIds[expiredQuoteIds[i]]);
			} else {
				emit ExpireQuoteOpen(result, expiredQuoteIds[i]);
			}
		}
	}

	/// @notice Requests to cancel the specified quote. If not yet locked, it is immediately canceled.
	///         For a locked quote, PartyB decides whether to accept the cancellation or proceed with opening.
	/// @param quoteId The ID of the quote to be canceled.
	function requestToCancelQuote(
		uint256 quoteId
	) external whenInstantModeIsNotActive(LibSigner.getSigner()) whenNotPartyAActionsPaused onlyPartyAOfQuote(quoteId) notLiquidated(quoteId) {
		QuoteStatus result = PartyAFacetImpl.requestToCancelQuote(quoteId);
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		if (result == QuoteStatus.EXPIRED) {
			emit ExpireQuoteOpen(result, quoteId);
		} else if (result == QuoteStatus.CANCELED || result == QuoteStatus.CANCEL_PENDING) {
			emit RequestToCancelQuote(quote.partyA, quote.partyB, result, quoteId);
		}
	}

	/// @notice User requests to close one of their positions.
	/// @param quoteId The ID of the quote associated with the position to be closed.
	/// @param closePrice The closing price for the position. For limit orders, the exact price; for market orders, a price threshold.
	/// @param quantityToClose The quantity of the position to be closed.
	/// @param orderType LIMIT, MARKET, or the close-only MARKET_BEST_EFFORT mode
	/// @param deadline Expiration timestamp for the close request
	function requestToClosePosition(
		uint256 quoteId,
		uint256 closePrice,
		uint256 quantityToClose,
		OrderType orderType,
		uint256 deadline
	) external whenInstantModeIsNotActive(LibSigner.getSigner()) whenNotPartyAActionsPaused onlyPartyAOfQuote(quoteId) notLiquidated(quoteId) {
		PartyAFacetImpl.requestToClosePosition(quoteId, closePrice, quantityToClose, orderType, deadline);
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		emit RequestToClosePosition(
			quote.partyA,
			quote.partyB,
			quoteId,
			closePrice,
			quantityToClose,
			orderType,
			deadline,
			QuoteStatus.CLOSE_PENDING,
			quoteLayout.closeIds[quoteId]
		);
	}

	/// @notice Requests to cancel a pending position closure request.
	/// @param quoteId The ID of the quote associated with the position.
	function requestToCancelCloseRequest(
		uint256 quoteId
	) external whenInstantModeIsNotActive(LibSigner.getSigner()) whenNotPartyAActionsPaused onlyPartyAOfQuote(quoteId) notLiquidated(quoteId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		QuoteStatus result = PartyAFacetImpl.requestToCancelCloseRequest(quoteId);
		if (result == QuoteStatus.OPENED) {
			emit ExpireQuoteClose(QuoteStatus.OPENED, quoteId, quoteLayout.closeIds[quoteId]);
		} else if (result == QuoteStatus.CANCEL_CLOSE_PENDING) {
			emit RequestToCancelCloseRequest(quote.partyA, quote.partyB, quoteId, QuoteStatus.CANCEL_CLOSE_PENDING, quoteLayout.closeIds[quoteId]);
		}
	}
}
