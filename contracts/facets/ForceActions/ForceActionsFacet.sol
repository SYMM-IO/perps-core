// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../utils/Accessibility.sol";
import "../../utils/Pausable.sol";
import "../../interfaces/IPartiesEvents.sol";
import "./IForceActionsFacet.sol";
import "./ForceActionsFacetImpl.sol";
import "../../facets/Settlement/SettlementFacetEvents.sol";

contract ForceActionsFacet is Accessibility, Pausable, IPartiesEvents, IForceActionsFacet, SettlementFacetEvents {
	/**
	 * @notice Forces the cancellation of the specified quote when partyB is not responsive for a certian amount of time(ForceCancelCooldown).
	 * @param quoteId The ID of the quote to be canceled.
	 */
	function forceCancelQuote(uint256 quoteId) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		ForceActionsFacetImpl.forceCancelQuote(quoteId);
		emit ForceCancelQuote(quoteId, QuoteStatus.CANCELED);
	}

	/**
	 * @notice Forces the cancellation of the close request associated with the specified quote when partyB is not responsive for a certain amount of time(ForceCancelCloseCooldown).
	 * @param quoteId The ID of the quote for which the close request should be canceled.
	 */
	function forceCancelCloseRequest(uint256 quoteId) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		ForceActionsFacetImpl.forceCancelCloseRequest(quoteId);
		emit ForceCancelCloseRequest(quoteId, QuoteStatus.OPENED, QuoteStorage.layout().closeIds[quoteId]);
	}

	/**
	 * @notice Forces the closure of the position associated with the specified quote.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature.
	 */
	function forceClosePosition(uint256 quoteId, HighLowPriceSig memory sig) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		forceClose(quoteId, sig);
	}

	/**
	 * @notice Settles the positions then forces the closure of the position associated with the specified quote.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature.
	 * @param settleSig The data struct contains quoteIds and upnl of parties and market prices
	 * @param updatedPrices New prices to be set as openedPrice for the specified quotes.
	 */
	function settleAndForceClosePosition(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices
	) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		Quote memory quote = quoteLayout.quotes[quoteId];
		uint256[] memory newPartyBsAllocatedBalances = new uint256[](1);
		address partyA = quote.partyA;

		ForceActionsFacetImpl.settleUPNL(quoteId, settleSig, updatedPrices);
		newPartyBsAllocatedBalances[0] = accountLayout.partyBAllocatedBalances[quote.partyB][quote.partyA];
		emit SettleUpnl(
			settleSig.quotesSettlementsData,
			updatedPrices,
			msg.sender,
			accountLayout.allocatedBalances[partyA],
			newPartyBsAllocatedBalances
		);

		forceClose(quoteId, sig);
	}

	function initializeMasterAccountForceClose(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		uint256 closePrice = ForceActionsFacetImpl.forceCloseMasterAccountInit(quoteId, sig);
		emit ForceCloseInitialized(msg.sender, QuoteStorage.layout().quotes[quoteId].partyB, quoteId, sig.reqId, closePrice, sig.timestamp);	}

	function settleUpnlMasterAccount(
		uint256 forceCloseQuoteId,
		MasterAccountSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external whenNotPartyAActionsPaused {
		address partyB = settlementSig.partyB;

		(uint256[] memory _newPartyAsAllocatedBalances, address[] memory _partyAs) = ForceActionsFacetImpl.settleUpnlMasterAccount(
			forceCloseQuoteId,
			settlementSig,
			updatedPrices
		);

		emit SettleUpnlMasterAccount(
			settlementSig.reqId,
			settlementSig.quotesSettlementsData,
			updatedPrices,
			partyB,
			_partyAs,
			_newPartyAsAllocatedBalances,
			AccountStorage.layout().partyBAllocatedBalances[partyB][address(0)],
			forceCloseQuoteId
		);
	}

	function finalizeMasterAccountForceClose(uint256 quoteId) external {
		forceCloseFinalize(quoteId);
	}

	function forceCloseAndSettlePositionsMasterAccount(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		uint256 closePrice = ForceActionsFacetImpl.forceCloseMasterAccountInit(quoteId, sig);
		emit ForceCloseInitialized(msg.sender, QuoteStorage.layout().quotes[quoteId].partyB, quoteId, sig.reqId, closePrice, sig.timestamp);
		forceCloseFinalize(quoteId);
	}

	/* description: finalizes the force close process for a master account mode party B */
	// @param		quoteId  The ID of the quote for which the position should be forced to close.
	function forceCloseFinalize(uint256 quoteId) private {
		bool succeed = ForceActionsFacetImpl.finalizeMasterAccountForceClose(quoteId);
		Quote memory quote = QuoteStorage.layout().quotes[quoteId];
		emit ForceClosePositionMasterAccount(
			quoteId,
			quote.partyA,
			quote.partyB,
			quote.quantityToClose,
			AccountStorage.layout().forceCloseDetails[quoteId].closePrice,
			quote.quoteStatus,
			QuoteStorage.layout().closeIds[quoteId],
			succeed
		);
	}

	/* description: forces the closure of the position associated with the specified quote */
	// @param		quoteId  The ID of the quote for which the position should be forced to close.
	// @param		sig  The Muon signature.
	function forceClose(uint256 quoteId, HighLowPriceSig memory sig) private {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote memory quote = quoteLayout.quotes[quoteId];
		uint256[] memory newPartyBsAllocatedBalances = new uint256[](1);
		address partyA = quote.partyA;
		address partyB = quote.partyB;

		(uint256 closePrice, int256 upnlPartyB, bool succeed) = ForceActionsFacetImpl.forceClose(quoteId, sig);
		if (succeed) {
			emit ForceClosePosition(
				quoteId,
				quote.partyA,
				quote.partyB,
				quote.quantityToClose,
				closePrice,
				QuoteStorage.layout().quotes[quoteId].quoteStatus,
				quoteLayout.closeIds[quoteId]
			);
		} else {
			newPartyBsAllocatedBalances[0] = AccountStorage.layout().partyBAllocatedBalances[quote.partyB][partyA];
			emit LiquidatePartyB(msg.sender, partyB, partyA, newPartyBsAllocatedBalances[0], upnlPartyB);
		}
	}
}
