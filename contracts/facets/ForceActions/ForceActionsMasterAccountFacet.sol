// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IForceActionsMasterAccountFacet } from "./IForceActionsMasterAccountFacet.sol";
import { ForceActionsFacetImpl } from "./ForceActionsFacetImpl.sol";
import { SettlementFacetEvents } from "../../facets/Settlement/SettlementFacetEvents.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { HighLowPriceSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";

contract ForceActionsMasterAccountFacet is Accessibility, Pausable, IForceActionsMasterAccountFacet, SettlementFacetEvents {
	/**
	 * @notice Initializes the master-account force-close flow for a quote.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 */
	function initializeMasterAccountForceClose(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		_initializeMasterAccountForceClose(quoteId, sig);
	}

	/**
	 * @notice Settles uPNL for a force-close workflow using unified settlement.
	 * @param forceCloseQuoteId Same as quoteId for the force-close workflow.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function settleUpnlForForceClose(
		uint256 forceCloseQuoteId,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external whenNotPartyAActionsPaused {
		_settleUpnlForForceClose(forceCloseQuoteId, settlementSig, updatedPrices);
	}

	/**
	 * @notice Finalizes the master-account force-close flow.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 */
	function finalizeMasterAccountForceClose(uint256 quoteId) external {
		_finalizeMasterAccountForceClose(quoteId);
	}

	/**
	 * @notice Initializes, settles uPNL, and finalizes a master-account force close in a single transaction.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function forceCloseAndSettlePositionsMasterAccount(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external notLiquidated(quoteId) whenNotPartyAActionsPaused {
		_initializeMasterAccountForceClose(quoteId, sig);
		if (updatedPrices.length > 0) _settleUpnlForForceClose(quoteId, settlementSig, updatedPrices);
		_finalizeMasterAccountForceClose(quoteId);
	}

	/**
	 * @notice Initializes the master-account force-close flow for a quote.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature.
	 */
	function _initializeMasterAccountForceClose(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) private notLiquidated(quoteId) whenNotPartyAActionsPaused {
		uint256 closePrice = ForceActionsFacetImpl.forceCloseMasterAccountInit(quoteId, sig);
		emit ForceCloseInitialized(msg.sender, QuoteStorage.layout().quotes[quoteId].partyB, quoteId, sig.reqId, closePrice, sig.timestamp);
	}

	/**
	 * @notice Settles uPNL for a force-close workflow using unified settlement.
	 * @param forceCloseQuoteId Same as quoteId for the force-close workflow.
	 * @param settlementSig Unified settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during settlement.
	 */
	function _settleUpnlForForceClose(
		uint256 forceCloseQuoteId,
		UnifiedSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) private whenNotPartyAActionsPaused {
		address partyB = settlementSig.partyB;

		uint256[] memory _newPartyAsAllocatedBalances = ForceActionsFacetImpl.settleUpnlUnified(
			forceCloseQuoteId,
			settlementSig,
			updatedPrices
		);

		emit SettleUpnlUnified(
			settlementSig.reqId,
			settlementSig.quotesSettlementsData,
			updatedPrices,
			partyB,
			settlementSig.partyAs,
			_newPartyAsAllocatedBalances,
			AccountStorage.layout().partyBAllocatedBalances[partyB][address(0)]
		);
	}

	/**
	 * @notice Finalizes the force close process for a master account mode party B.
	 * @dev Emits isSolvent to indicate whether close used full upnlPartyB or ignore-upnl fallback.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 */
	function _finalizeMasterAccountForceClose(uint256 quoteId) private {
		bool isSolvent = ForceActionsFacetImpl.finalizeMasterAccountForceClose(quoteId);
		Quote memory quote = QuoteStorage.layout().quotes[quoteId];
		emit ForceClosePositionMasterAccount(
			quoteId,
			quote.partyA,
			quote.partyB,
			quote.quantityToClose,
			AccountStorage.layout().forceCloseDetails[quoteId].closePrice,
			quote.quoteStatus,
			QuoteStorage.layout().closeIds[quoteId],
			isSolvent
		);
	}
}
