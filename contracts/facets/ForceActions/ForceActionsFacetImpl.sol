// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonSettlement } from "../../libraries/muon/LibMuonSettlement.sol";
import { LibSettlement } from "../../libraries/LibSettlement.sol";
import { LibForceActions } from "../../libraries/LibForceActions.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage, ForceCloseDetail, UPNLSettlementState, PartyBForceCloseState } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { HighLowPriceSig, SettlementSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { LibMuonUnifiedSettlement } from "../../libraries/muon/LibMuonUnifiedSettlement.sol";

library ForceActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	function forceCancelQuote(uint256 quoteId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Enforce that the quote is in the expected cancel pending state. Revert with
		// a custom error if not.
		require(quote.quoteStatus == QuoteStatus.CANCEL_PENDING, "PartyAFacet: Invalid state");
		// Enforce that the force cancel cooldown has elapsed. If the current
		// timestamp has not yet surpassed the last modify timestamp plus the
		// cooldown period, revert.
		require(block.timestamp > quote.statusModifyTimestamp + maLayout.forceCancelCooldown, "PartyAFacet: Cooldown not reached");
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.CANCELED;
		accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
		LibAccount.subFromPartyBPendingLockedBalances(quote);

		// send trading Fee back to partyA
		uint256 fee = LibQuote.getOpenTradingFee(quote.id);
		accountLayout.allocatedBalances[quote.partyA] += fee;
		emit SharedEvents.BalanceChangePartyA(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);

		LibQuote.removeFromPendingQuotes(quote);
	}

	function forceCancelCloseRequest(uint256 quoteId) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Validate the quote is in the cancel close pending state.
		require(quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING, "PartyAFacet: Invalid state");
		// Ensure the cancel close cooldown period has expired before proceeding.
		require(block.timestamp > quote.statusModifyTimestamp + maLayout.forceCancelCloseCooldown, "PartyAFacet: Cooldown not reached");

		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.OPENED;
		quote.requestedClosePrice = 0;
		quote.quantityToClose = 0;
	}

	/**
	 * @notice Initializes the 3-step force close flow (works for both normal and master account modes).
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @param sig The Muon signature to calculate the close price.
	 * @return closePrice The calculated close price.
	 */
	function forceCloseInit(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice) {
		LibForceActions.validateForceCloseConditions(quoteId, sig);
		closePrice = LibForceActions.verifyAndGetClosePrice(quoteId, sig);

		(, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.currentPrice,
			sig.upnlPartyA,
			sig.upnlPartyB,
			closePrice
		);

		require(partyAAvailableBalance >= 0, "PartyAFacet: PartyA will be insolvent");

		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.closePrice = closePrice;
		detail.upnlPartyB = sig.upnlPartyB;
		detail.currentPrice = sig.currentPrice;
		detail.inProgress = true;
	}

	/**
	 * @notice Finalizes the 3-step force close flow (handles both normal and master account modes).
	 * @dev For normal partyB: Uses reserveVault fallback and triggers liquidation if needed.
	 *      For master account: Uses SOLVENT/INSOLVENT marking without liquidation.
	 * @param quoteId The ID of the quote for which the position should be forced to close.
	 * @return succeed Whether the close was successful without liquidation/insolvency.
	 * @return upnlPartyB The upnl used for liquidation (only set for normal partyB when succeed is false).
	 */
	function finalizeForceClose(uint256 quoteId) internal returns (bool succeed, int256 upnlPartyB) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		address partyB = QuoteStorage.layout().quotes[quoteId].partyB;
		bool isMasterAccountMode = accountLayout.masterAccountMode[partyB];

		if (isMasterAccountMode) {
			// Master account mode: Use SOLVENT/INSOLVENT marking without liquidation
			(succeed, detail.partyBAvailableAfterClose) = LibForceActions.closeQuoteMasterAccountWithRespectToUpnl(
				quoteId,
				detail.currentPrice,
				detail.upnlPartyB,
				detail.closePrice
			);
			detail.partyBState = succeed ? PartyBForceCloseState.SOLVENT : PartyBForceCloseState.INSOLVENT;
		} else {
			// Normal partyB mode: Use reserveVault fallback and liquidation
			uint256 reservedBalance = accountLayout.reserveVault[partyB];

			(int256 partyBAvailableBalance, ) = LibForceActions.getAvailableBalancesAfterClose(
				quoteId,
				detail.currentPrice,
				0,
				detail.upnlPartyB,
				detail.closePrice
			);

			succeed = LibForceActions.closeQuote(quoteId, detail.closePrice, partyBAvailableBalance, reservedBalance);
			detail.partyBAvailableAfterClose = partyBAvailableBalance;

			if (succeed) {
				detail.partyBState = PartyBForceCloseState.SOLVENT;
			} else {
				upnlPartyB = LibForceActions.liquidatePartyB(
					quoteId,
					detail.closePrice,
					reservedBalance,
					detail.upnlPartyB,
					detail.currentPrice
				);
				detail.partyBState = PartyBForceCloseState.LIQUIDATED;
			}
		}

		// Clean up
		detail.inProgress = false;
		detail.timestamp = block.timestamp;
		detail.upnlPartyB = 0;
		detail.currentPrice = 0;
	}

	function forceClose(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice, int256 upnlPartyB, bool succeed) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address partyB = QuoteStorage.layout().quotes[quoteId].partyB;

		require(!accountLayout.masterAccountMode[partyB], "ForceActionsFacet: Master account mode enabled");

		LibForceActions.validateForceCloseConditions(quoteId, sig);
		closePrice = LibForceActions.verifyAndGetClosePrice(quoteId, sig);

		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.currentPrice,
			sig.upnlPartyA,
			sig.upnlPartyB,
			closePrice
		);

		require(partyAAvailableBalance >= 0, "PartyAFacet: PartyA will be insolvent");

		uint256 reservedBalance = accountLayout.reserveVault[partyB];
		succeed = LibForceActions.closeQuote(quoteId, closePrice, partyBAvailableBalance, reservedBalance);

		if (!succeed) {
			upnlPartyB = LibForceActions.liquidatePartyB(quoteId, closePrice, reservedBalance, sig.upnlPartyB, sig.currentPrice);
		}
	}

	/* Force Close Settlement Functions*/

	/**
	 * @dev DEPRECATED: This function is kept for backward compatibility. Use settleUpnlUnified instead,
	 *      which supports both masterAccount and normal partyB modes with a unified signature format.
	 */
	function settleUPNL(uint256 quoteId, SettlementSig memory sig, uint256[] memory updatedPrices) internal {
		address partyA = QuoteStorage.layout().quotes[quoteId].partyA;

		//realize uPNL
		LibMuonSettlement.verifySettlement(sig, partyA);
		LibSettlement.settleUpnl(sig, updatedPrices, partyA, true);

		//update force close detail struct
		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.settlementState = UPNLSettlementState.REALIZED;
	}

	function settleUpnlUnified(
		uint256 quoteId,
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];

		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		// Verify signature using unified settlement verification
		bool isMasterAccountMode = accountLayout.masterAccountMode[sig.partyB];
		LibMuonUnifiedSettlement.verifyUnifiedSettlement(sig, isMasterAccountMode);

		// Use the unified settlement function with isForceClose=true
		newPartyAsAllocatedBalances = LibSettlement.settleUpnlUnified(sig, updatedPrices, true);
		detail.timestamp = block.timestamp;
	}
}
