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
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibHook } from "../../libraries/LibHook.sol";
import { HighLowPriceSig, SettlementSig } from "../../storages/MuonStorage.sol";
import { LibConnections } from "../../libraries/LibConnections.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library ForceActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	/// @notice Force-cancels a pending quote after the force cancel cooldown has elapsed, refunding locked balances and trading fees.
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
		LibAccount.refundOpenTradingFee(quote.id, quote.partyA);

		LibQuote.removeFromPendingQuotes(quote);
		LibConnections.removeConnectionIfNoPositions(quote.partyA, quote.partyB);
		LibHook.callCancelQuoteHooks(quote.id, quote.partyA, quote.partyB, quote.affiliate);
	}

	/// @notice Force-cancels a pending close request after the force cancel close cooldown has elapsed.
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
		LibHook.callCloseExpiredHooks(quote.id, quote.partyA, quote.partyB, quote.affiliate);
	}

	/// @notice Executes a force close for a non-cross partyB, using the reserve vault fallback and triggering liquidation if partyB is insolvent.
	function forceClose(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) internal returns (uint256 closePrice, int256 upnlPartyB, bool succeed, uint256 partyBAllocatedBalanceBeforeLiquidation) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address partyB = QuoteStorage.layout().quotes[quoteId].partyB;

		require(!MAStorage.layout().crossModeEnabledForPartyB[partyB], "ForceActionsFacet: Cross partyB mode enabled");

		LibForceActions.validateForceCloseConditions(quoteId, sig, MuonFunction.ForceClose);
		closePrice = LibForceActions.verifyAndGetClosePrice(quoteId, sig);

		(, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.currentPrice,
			sig.upnlPartyA,
			sig.upnlPartyB,
			closePrice
		);

		require(partyAAvailableBalance >= 0, "PartyAFacet: PartyA will be insolvent");

		uint256 reservedBalance = accountLayout.reserveVault[partyB];
		(succeed, ) = LibForceActions.closeQuoteWithReserveFallback(quoteId, sig.currentPrice, sig.upnlPartyB, closePrice);

		if (!succeed) {
			(upnlPartyB, partyBAllocatedBalanceBeforeLiquidation) = LibForceActions.startPartyBLiquidationForForceClose(
				quoteId,
				closePrice,
				reservedBalance,
				sig.upnlPartyB,
				sig.currentPrice
			);
		}
	}

	/// @notice Settles UPNL before a force close operation using the legacy settlement signature format.
	/// @dev DEPRECATED: Use settleUpnlUnified in ForceCloseStepsImpl instead,
	///      which supports both crossPartyB and normal partyB modes with a unified signature format.
	function settleUPNL(
		uint256 quoteId,
		SettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyBsAllocatedBalances) {
		address partyA = QuoteStorage.layout().quotes[quoteId].partyA;

		//realize uPNL
		LibMuonSettlement.verifySettlement(sig, partyA, MuonFunction.ForceClose);
		newPartyBsAllocatedBalances = LibSettlement.settleUpnl(sig, updatedPrices, partyA, true);
	}
}
