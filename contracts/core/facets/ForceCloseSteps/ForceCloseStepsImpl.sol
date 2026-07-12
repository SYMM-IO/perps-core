// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibSettlement } from "../../libraries/LibSettlement.sol";
import { LibForceActions } from "../../libraries/LibForceActions.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";
import { QuoteStorage, Quote, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage, ForceCloseDetail, PartyBForceCloseState } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { HighLowPriceSig, PairUpnlAndPriceSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { LibMuonUnifiedSettlement } from "../../libraries/muon/LibMuonUnifiedSettlement.sol";
import { LibMuonPartyB } from "../../libraries/muon/LibMuonPartyB.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library ForceCloseStepsImpl {
	using LockedValuesOps for LockedValues;

	/// @notice Initializes the 3-step force close flow (works for both normal and cross partyB modes).
	/// @param quoteId The ID of the quote for which the position should be forced to close.
	/// @param sig The Muon signature to calculate the close price.
	/// @return closePrice The calculated close price.
	function forceCloseInit(uint256 quoteId, HighLowPriceSig memory sig) internal returns (uint256 closePrice) {
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

		ForceCloseDetail storage detail = AccountStorage.layout().forceCloseDetails[quoteId];
		// Observability-only metadata: last Muon request id used for the stored snapshot.
		detail.priceSigId = sig.reqId;
		detail.quoteId = quoteId;
		detail.timestamp = block.timestamp;
		detail.partyBAvailableAfterClose = 0;
		detail.closePrice = closePrice;
		detail.upnlPartyB = sig.upnlPartyB;
		detail.currentPrice = sig.currentPrice;
		detail.partyBState = PartyBForceCloseState.NONE;
		detail.inProgress = true;
	}

	/// @notice Refreshes the force-close uPNL/currentPrice snapshot using a fresh PairUpnlAndPriceSig.
	/// @dev Does not modify the previously calculated closePrice. Re-validates partyA solvency; reverts if partyA would be insolvent.
	function refreshForceCloseSnapshot(uint256 quoteId, PairUpnlAndPriceSig memory sig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		LibMuonPartyB.verifyPairUpnlAndPrice(sig, quote.partyB, quote.partyA, quote.symbolId, MuonFunction.ForceClose);

		// Ensure partyA solvency for the stored closePrice with this fresh snapshot.
		(, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.price,
			sig.upnlPartyA,
			sig.upnlPartyB,
			detail.closePrice
		);
		require(partyAAvailableBalance >= 0, "PartyAFacet: PartyA will be insolvent");

		// Observability-only metadata: last Muon request id used for the stored snapshot.
		detail.priceSigId = sig.reqId;
		detail.upnlPartyB = sig.upnlPartyB;
		detail.currentPrice = sig.price;
		detail.timestamp = block.timestamp;
	}

	/// @notice Finalizes the 3-step force close flow (handles both normal and cross partyB modes).
	/// @dev For normal partyB: Uses reserveVault fallback and triggers liquidation if needed.
	///      For cross partyB: Uses CLOSED_SOLVENT/CLOSED_INSOLVENT marking without liquidation.
	/// @param quoteId The ID of the quote for which the position should be forced to close.
	/// @return isPartyBSolvent Whether PartyB remained solvent after the close.
	/// @return upnlPartyB The upnl used for liquidation (only set for normal partyB when isPartyBSolvent is false).
	function finalizeForceClose(uint256 quoteId) internal returns (bool isPartyBSolvent, int256 upnlPartyB) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		address partyB = QuoteStorage.layout().quotes[quoteId].partyB;
		LibSymbolAdjustment.requireNotFrozen(QuoteStorage.layout().quotes[quoteId].symbolId);
		bool isCrossPartyB = MAStorage.layout().crossModeEnabledForPartyB[partyB];

		if (isCrossPartyB) {
			// Cross partyB mode: Use CLOSED_SOLVENT/CLOSED_INSOLVENT marking without liquidation
			(isPartyBSolvent, detail.partyBAvailableAfterClose) = LibForceActions.closeQuoteCrossIgnoringUpnl(
				quoteId,
				detail.currentPrice,
				detail.upnlPartyB,
				detail.closePrice
			);
			detail.partyBState = isPartyBSolvent ? PartyBForceCloseState.CLOSED_SOLVENT : PartyBForceCloseState.CLOSED_INSOLVENT;
		} else {
			// Normal partyB mode: Use reserveVault fallback and liquidation
			(isPartyBSolvent, detail.partyBAvailableAfterClose) = LibForceActions.closeQuoteWithReserveFallback(
				quoteId,
				detail.currentPrice,
				detail.upnlPartyB,
				detail.closePrice
			);

			if (isPartyBSolvent) {
				detail.partyBState = PartyBForceCloseState.CLOSED_SOLVENT;
			} else {
				uint256 reservedBalance = accountLayout.reserveVault[partyB];
				upnlPartyB = LibForceActions.startPartyBLiquidationForForceClose(
					quoteId,
					detail.closePrice,
					reservedBalance,
					detail.upnlPartyB,
					detail.currentPrice
				);
				detail.partyBState = PartyBForceCloseState.CLOSED_LIQUIDATED;
			}
		}

		// Clean up
		detail.inProgress = false;
		detail.timestamp = block.timestamp;
		detail.upnlPartyB = 0;
		detail.currentPrice = 0;
	}

	/// @notice Settles UPNL using unified settlement during the force close workflow and adjusts the stored partyB UPNL snapshot.
	function settleUpnlUnified(
		uint256 quoteId,
		UnifiedSettlementSig memory sig,
		uint256[] memory updatedPrices
	) internal returns (uint256[] memory newPartyAsAllocatedBalances) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];

		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage forceCloseQuote = quoteLayout.quotes[quoteId];
		bool isSamePartyB = forceCloseQuote.partyB == sig.partyB;

		// Verify signature using unified settlement verification
		bool isCrossPartyB = MAStorage.layout().crossModeEnabledForPartyB[sig.partyB];

		// Non-cross partyB: only allow settling positions with the forceClose partyA
		if (!isCrossPartyB && isSamePartyB) {
			require(sig.partyAs.length == 1, "ForceActionsFacet: Non-cross partyB can only settle with forceClose partyA");
			require(sig.partyAs[0] == forceCloseQuote.partyA, "ForceActionsFacet: Invalid partyA for non-cross settlement");
		}
		LibMuonUnifiedSettlement.verifyUnifiedSettlement(sig, isCrossPartyB, MuonFunction.ForceClose);

		// Use the unified settlement function with privilegedMode=true
		int256[] memory settleAmountsPerPartyA;
		(newPartyAsAllocatedBalances, settleAmountsPerPartyA) = LibSettlement.settleUpnlUnified(sig, updatedPrices, true, true);

		// Settlement signatures do not include the force-close quote price/currentPrice, so we only shift uPNL by the
		// realized settlement delta and keep currentPrice unchanged (it should be refreshed via refresh/finalize sig).
		if (isSamePartyB) {
			if (isCrossPartyB) {
				int256 totalSettlementAmount;
				for (uint256 i = 0; i < settleAmountsPerPartyA.length; i++) {
					totalSettlementAmount += settleAmountsPerPartyA[i];
				}
				detail.upnlPartyB = detail.upnlPartyB + totalSettlementAmount;
			} else {
				uint256 forceClosePartyAIndex = type(uint256).max;
				for (uint256 i = 0; i < sig.partyAs.length; i++) {
					if (sig.partyAs[i] == forceCloseQuote.partyA) {
						forceClosePartyAIndex = i;
						break;
					}
				}
				if (forceClosePartyAIndex != type(uint256).max) {
					detail.upnlPartyB = detail.upnlPartyB + settleAmountsPerPartyA[forceClosePartyAIndex];
				}
			}
		}

		// Always advance workflow timestamp.
		detail.timestamp = block.timestamp;
	}
}
