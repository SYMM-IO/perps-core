// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IPartiesEvents } from "../../interfaces/IPartiesEvents.sol";
import { IForceCloseStepsFacet } from "./IForceCloseStepsFacet.sol";
import { ForceCloseStepsImpl } from "./ForceCloseStepsImpl.sol";
import { SettlementFacetEvents } from "../../facets/Settlement/SettlementFacetEvents.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { CrossPartyBStorage } from "../../storages/CrossPartyBStorage.sol";
import { HighLowPriceSig, PairUpnlAndPriceSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";

contract ForceCloseStepsFacet is Accessibility, Pausable, IPartiesEvents, IForceCloseStepsFacet, SettlementFacetEvents {
	/**
	 * @notice Initializes the 3-step force close flow (works for both normal and cross partyB modes).
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
	 * @notice Finalizes the 3-step force close flow using a fresh PairUpnlAndPriceSig to refresh uPNL/currentPrice.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig Fresh Muon signature (uPNLs + currentPrice).
	 */
	function finalizeForceClose(uint256 quoteId, PairUpnlAndPriceSig memory sig) external {
		ForceCloseStepsImpl.refreshForceCloseSnapshot(quoteId, sig);
		_finalizeForceCloseWithoutSig(quoteId);
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
		_finalizeForceCloseWithoutSig(quoteId);
	}

	/**
	 * @notice Private: Initializes the force close flow.
	 */
	function _initializeForceClose(uint256 quoteId, HighLowPriceSig memory sig) private {
		uint256 closePrice = ForceCloseStepsImpl.forceCloseInit(quoteId, sig);
		emit ForceCloseInitialized(msg.sender, QuoteStorage.layout().quotes[quoteId].partyB, quoteId, sig.reqId, closePrice, sig.timestamp);
	}

	/**
	 * @notice Private: Settles uPNL for the force close using unified settlement.
	 */
	function _settleUpnlForForceClose(uint256 quoteId, UnifiedSettlementSig memory settlementSig, uint256[] memory updatedPrices) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		bool isCrossPartyB = CrossPartyBStorage.layout().crossModeEnabledForPartyB[settlementSig.partyB];

		uint256[] memory newPartyAsAllocatedBalances = ForceCloseStepsImpl.settleUpnlUnified(quoteId, settlementSig, updatedPrices);

		// For cross partyB mode, use address(0) as allocation key; for normal mode use partyAs[0]
		address allocKey = isCrossPartyB ? address(0) : settlementSig.partyAs[0];

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

	function _finalizeForceCloseWithoutSig(uint256 quoteId) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote memory quote = quoteLayout.quotes[quoteId];
		address partyB = quote.partyB;

		bool isCrossPartyB = CrossPartyBStorage.layout().crossModeEnabledForPartyB[partyB];
		(bool succeed, int256 upnlPartyB) = ForceCloseStepsImpl.finalizeForceClose(quoteId);

		if (isCrossPartyB) {
			// Cross partyB mode: emit event with solvency flag
			emit ForceClosePositionCross(
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
				emit LiquidatePartyB(msg.sender, partyB, quote.partyA, accountLayout.partyBAllocatedBalances[partyB][quote.partyA], upnlPartyB);
			}
		}
	}
}
