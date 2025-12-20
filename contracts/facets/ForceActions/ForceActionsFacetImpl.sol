// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../libraries/muon/LibMuonForceActions.sol";
import "../../libraries/muon/LibMuonSettlement.sol";
import "../../libraries/muon/LibMuonCrossSettlement.sol";
import "../../libraries/LibSettlement.sol";
import "../../libraries/LibLiquidation.sol";
import "../../libraries/LibForceActions.sol";
import "../../libraries/LibSolvency.sol";
import "../../libraries/LibAccount.sol";
import "../../storages/QuoteStorage.sol";
import "../../storages/AccountStorage.sol";

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

	function forceCloseMasterAccountInit(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice) {
		require(
			AccountStorage.layout().masterAccountMode[QuoteStorage.layout().quotes[quoteId].partyB],
			"ForceActionsFacet: Master account mode inactive"
		);

		LibForceActions.validateForceCloseConditions(quoteId, sig);
		closePrice = LibForceActions.verifyAndGetClosePrice(quoteId, sig);

		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.closePrice = closePrice;
		detail.upnlPartyB = sig.upnlPartyB;
		detail.currentPrice = sig.currentPrice;
		detail.inProgress = true;
	}

	function finalizeMasterAccountForceClose(uint256 quoteId) internal returns (bool isSolvent) {
		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];

		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		(isSolvent,  detail.partyBAvailableAfterClose) = LibForceActions.closeQuoteMasterAccountWithRespectToUpnl(
			quoteId,
			detail.currentPrice,
			detail.upnlPartyB,
			detail.closePrice
		);

		detail.partyBState = isSolvent ? PartyBForceCloseState.SOLVENT : PartyBForceCloseState.INSOLVENT;
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

	function settleUpnlMasterAccount(
		uint256 quoteId,
		MasterAccountSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances, address[] memory partyAs) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];

		require(detail.inProgress, "ForceActionsFacet: Invalid state");
		LibMuonCrossSettlement.verifyMasterAccountSettlement(sig);
		(newPartyAsAllocatedBalances, partyAs) = LibSettlement.settleUpnlMasterAccount(sig, updatedPrices);
		detail.timestamp = block.timestamp;
	}
}
