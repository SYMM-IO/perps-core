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

import "../Settlement/SettlementFacetEvents.sol";

// Import the interface solely for custom error declarations. Having the errors
// in a central interface allows multiple facets and libraries to share them
// without coupling to the full implementation. See IForceActionsFacet.sol for
// the error definitions.
import "./IForceActionsFacet.sol";

library ForceActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	function forceCancelQuote(uint256 quoteId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		Quote storage quote = QuoteStorage.layout().quotes[quoteId];

		// Enforce that the quote is in the expected cancel pending state. Revert with
		// a custom error if not.
		if (quote.quoteStatus != QuoteStatus.CANCEL_PENDING) {
			revert ForceCloseErrors.InvalidState();
		}
		// Enforce that the force cancel cooldown has elapsed. If the current
		// timestamp has not yet surpassed the last modify timestamp plus the
		// cooldown period, revert.
		if (!(block.timestamp > quote.statusModifyTimestamp + maLayout.forceCancelCooldown)) {
			revert ForceCloseErrors.CooldownNotReached();
		}
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.CANCELED;
		accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
		accountLayout.partyBPendingLockedBalances[quote.partyB][LibAccount.partyBAllocationBucket(quote.partyB, quote.partyA)].subQuote(quote);

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
		if (quote.quoteStatus != QuoteStatus.CANCEL_CLOSE_PENDING) {
			revert ForceCloseErrors.InvalidState();
		}
		// Ensure the cancel close cooldown period has expired before proceeding.
		if (!(block.timestamp > quote.statusModifyTimestamp + maLayout.forceCancelCloseCooldown)) {
			revert ForceCloseErrors.CooldownNotReached();
		}

		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.OPENED;
		quote.requestedClosePrice = 0;
		quote.quantityToClose = 0;
	}

	function forceCloseMasterAccountInit(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice) {
		if (!AccountStorage.layout().masterAccountMode[QuoteStorage.layout().quotes[quoteId].partyB])
			revert ForceCloseErrors.MasterAccountModeInactive();

		LibForceActions.verifyPrice(quoteId, sig);
		closePrice = LibForceActions.verifyAndGetClosePrice(quoteId, sig);

		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.currentPrice,
			sig.upnlPartyA,
			sig.upnlPartyB,
			closePrice
		);

		if (!(partyAAvailableBalance >= 0)) revert ForceCloseErrors.PartyAWillBeInsolvent();

		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.partyBAvailableAfterClose = partyBAvailableBalance;
		detail.closePrice = closePrice;
		detail.inProgress = true;
	}

	function _forceClose(
		uint256 quoteId,
		uint256 closePrice,
		int256 partyBAvailableBalance,
		uint256 reservedBalance,
		int256 upnlPartyB,
		uint256 currentPrice,
		bool isMasterAccount
	) internal returns (bool isSolvent, bool isPartyBLiquidated, int256 _upnlPartyB) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		isSolvent = LibForceActions.solveUsingAllocatedBalances(quoteId, closePrice, partyBAvailableBalance, reservedBalance, isMasterAccount);

		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.inProgress = false;

		if (isSolvent) {
			detail.partyBState = PartyBForceCloseState.SOLVED;
		} else {
			if (!isMasterAccount) {
				_upnlPartyB = LibForceActions.liquidatePartyB(quoteId, closePrice, reservedBalance, upnlPartyB, currentPrice);
				isPartyBLiquidated = true;
				detail.partyBState = PartyBForceCloseState.LIQUIDATED;
			}
		}
	}

	function finalizeMasterAccountForceClose(uint256 quoteId) internal returns (bool isSolvent) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		if (!accountLayout.masterAccountMode[QuoteStorage.layout().quotes[quoteId].partyB]) revert ForceCloseErrors.MasterAccountModeInactive();

		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		(isSolvent, , ) = _forceClose(
			quoteId,
			detail.closePrice,
			detail.partyBAvailableAfterClose,
			accountLayout.partyBAllocatedBalances[QuoteStorage.layout().quotes[quoteId].partyB][address(0)],
			0,
			0,
			true
		);
		detail.inProgress = false;
		detail.timestamp = block.timestamp;
	}

	function forceClose(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) internal returns (uint256 closePrice, int256 upnlPartyB, bool isPartyBLiquidated) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address partyB = QuoteStorage.layout().quotes[quoteId].partyB;

		if (accountLayout.masterAccountMode[partyB]) revert ForceCloseErrors.MasterAccountModeEnabled();

		LibForceActions.verifyPrice(quoteId, sig);
		closePrice = LibForceActions.verifyAndGetClosePrice(quoteId, sig);

		(int256 partyBAvailableBalance, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.currentPrice,
			sig.upnlPartyA,
			sig.upnlPartyB,
			closePrice
		);

		if (!(partyAAvailableBalance >= 0)) {
			revert ForceCloseErrors.PartyAWillBeInsolvent();
		}

		uint256 reservedBalance = accountLayout.reserveVault[partyB];
		(, isPartyBLiquidated, upnlPartyB) = _forceClose(
			quoteId,
			closePrice,
			partyBAvailableBalance,
			reservedBalance,
			sig.upnlPartyB,
			sig.currentPrice,
			false
		);
	}

	function settleUPNL(uint256 quoteId, SettlementSig memory sig, uint256[] memory updatedPrices) internal {
		uint256[] memory newPartyBsAllocatedBalances = new uint256[](1);
		address partyA = QuoteStorage.layout().quotes[quoteId].partyA;

		LibMuonSettlement.verifySettlement(sig, partyA);
		newPartyBsAllocatedBalances = LibSettlement.settleUpnl(sig, updatedPrices, partyA, true);
		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		detail.timestamp = block.timestamp;
		detail.settlementState = UPNLSettlementState.REALIZED;
	}

	function settleUpnlMasterAccount(
		uint256 forceCloseId,
		MasterAccountSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances, address[] memory partyAs) {
		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[forceCloseId];

		if (!detail.inProgress) revert ForceCloseErrors.InvalidState();

		LibMuonCrossSettlement.verifyMasterAccountSettlement(sig);
		(newPartyAsAllocatedBalances, partyAs) = LibSettlement.settleUpnlMasterAccount(sig, updatedPrices, true);
		detail.settlementState = UPNLSettlementState.REALIZED_MASTER_ACCOUNT;
		detail.timestamp = block.timestamp;
	}
}
