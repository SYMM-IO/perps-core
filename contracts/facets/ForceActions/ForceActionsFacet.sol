// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";
import { IForceActionsFacet } from "./IForceActionsFacet.sol";
import { ForceActionsFacetImpl } from "./ForceActionsFacetImpl.sol";
import { SettlementFacetEvents } from "../../facets/Settlement/SettlementFacetEvents.sol";
import { QuoteStorage, Quote, QuoteStatus } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { HighLowPriceSig, SettlementSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";

contract ForceActionsFacet is Accessibility, Pausable, IPartiesEvents, IForceActionsFacet, SettlementFacetEvents {
	/**
	 * @notice Forces the cancellation of the specified quote when partyB is not responsive for a certain amount of time(ForceCancelCooldown).
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
	 * @param sig The Muon signature to calculate the close price.
	 */
	function forceClosePosition(uint256 quoteId, HighLowPriceSig memory sig) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		_forceClose(quoteId, sig);
	}

	/**
	 * @notice Settles the positions then forces the closure of the position associated with the specified quote.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 * @param settleSig The data struct contains quoteIds and upnl of parties and market prices
	 * @param updatedPrices New prices to be set as openedPrice for the specified quotes.
	 * @dev DEPRECATED: This function is kept for backward compatibility. Use forceCloseAndSettlePositionsUnified instead,
	 *      which supports UnifiedSettlementSig for better multi-partyB coordination.
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

		_forceClose(quoteId, sig);
	}

	/**
	 * @notice Forces the closure of the position associated with the specified quote.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature.
	 */
	function _forceClose(uint256 quoteId, HighLowPriceSig memory sig) private {
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
				quoteLayout.quotes[quoteId].quoteStatus,
				quoteLayout.closeIds[quoteId]
			);
		} else {
			newPartyBsAllocatedBalances[0] = AccountStorage.layout().partyBAllocatedBalances[quote.partyB][partyA];
			emit LiquidatePartyB(msg.sender, partyB, partyA, newPartyBsAllocatedBalances[0], upnlPartyB);
		}
	}

	/* 3-Step Force Close Functions (unified for both normal and master account modes) */

	/**
	 * @notice Initializes the 3-step force close flow (works for both normal and master account modes).
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 */
	function initializeForceClose(uint256 quoteId, HighLowPriceSig memory sig) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		_initializeForceClose(quoteId, sig);
	}

	/**
	 * @notice Settles uPNL for the 3-step force close using unified settlement.
	 * @param quoteId The ID of the quote for the force close workflow.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function settleUpnlForForceClose(
		uint256 quoteId,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external whenNotPartyAActionsPaused {
		_settleUpnlForForceClose(quoteId, settlementSig, updatedPrices);
	}

	/**
	 * @notice Finalizes the 3-step force close flow (handles both normal and master account modes).
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 */
	function finalizeForceClose(uint256 quoteId) external {
		_finalizeForceClose(quoteId);
	}

	/**
	 * @notice Initializes, settles uPNL, and finalizes the force close in a single transaction.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function forceCloseAndSettlePositionsUnified(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		_initializeForceClose(quoteId, sig);
		if (updatedPrices.length > 0) _settleUpnlForForceClose(quoteId, settlementSig, updatedPrices);
		_finalizeForceClose(quoteId);
	}

	/**
	 * @notice Private: Initializes the force close flow.
	 */
	function _initializeForceClose(uint256 quoteId, HighLowPriceSig memory sig) private {
		uint256 closePrice = ForceActionsFacetImpl.forceCloseInit(quoteId, sig);
		emit ForceCloseInitialized(
			msg.sender,
			QuoteStorage.layout().quotes[quoteId].partyB,
			quoteId,
			sig.reqId,
			closePrice,
			sig.timestamp
		);
	}

	/**
	 * @notice Private: Settles uPNL for the force close using unified settlement.
	 */
	function _settleUpnlForForceClose(
		uint256 quoteId,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		bool isMasterAccountMode = accountLayout.masterAccountMode[settlementSig.partyB];

		uint256[] memory newPartyAsAllocatedBalances = ForceActionsFacetImpl.settleUpnlUnified(
			quoteId,
			settlementSig,
			updatedPrices
		);

		// For master account mode, use address(0) as allocation key; for normal mode use partyAs[0]
		address allocKey = isMasterAccountMode ? address(0) : settlementSig.partyAs[0];

		emit SettleUpnlUnified(
			settlementSig.reqId,
			settlementSig.quotesSettlementsData,
			updatedPrices,
			settlementSig.partyB,
			settlementSig.partyAs,
			newPartyAsAllocatedBalances,
			accountLayout.partyBAllocatedBalances[settlementSig.partyB][allocKey]
		);
	}

	/**
	 * @notice Private: Finalizes the force close (handles both normal and master account modes).
	 */
	function _finalizeForceClose(uint256 quoteId) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote memory quote = quoteLayout.quotes[quoteId];
		address partyB = quote.partyB;

		bool isMasterAccountMode = accountLayout.masterAccountMode[partyB];
		(bool succeed, int256 upnlPartyB) = ForceActionsFacetImpl.finalizeForceClose(quoteId);

		if (isMasterAccountMode) {
			// Master account mode: emit event with solvency flag
			emit ForceClosePositionMasterAccount(
				quoteId,
				quote.partyA,
				partyB,
				quote.quantityToClose,
				accountLayout.forceCloseDetails[quoteId].closePrice,
				quoteLayout.quotes[quoteId].quoteStatus,
				quoteLayout.closeIds[quoteId],
				succeed
			);
		} else {
			// Normal partyB mode
			if (succeed) {
				emit ForceClosePosition(
					quoteId,
					quote.partyA,
					partyB,
					quote.quantityToClose,
					accountLayout.forceCloseDetails[quoteId].closePrice,
					quoteLayout.quotes[quoteId].quoteStatus,
					quoteLayout.closeIds[quoteId]
				);
			} else {
				emit LiquidatePartyB(
					msg.sender,
					partyB,
					quote.partyA,
					accountLayout.partyBAllocatedBalances[partyB][quote.partyA],
					upnlPartyB
				);
			}
		}
	}
}
