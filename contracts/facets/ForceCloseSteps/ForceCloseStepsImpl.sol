// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibSettlement } from "../../libraries/LibSettlement.sol";
import { LibForceActions } from "../../libraries/LibForceActions.sol";
import { QuoteStorage, Quote, LockedValues } from "../../storages/QuoteStorage.sol";
import { AccountStorage, ForceCloseDetail, PartyBForceCloseState } from "../../storages/AccountStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { HighLowPriceSig, PairUpnlAndPriceSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { LibMuonUnifiedSettlement } from "../../libraries/muon/LibMuonUnifiedSettlement.sol";
import { LibMuonPartyB } from "../../libraries/muon/LibMuonPartyB.sol";

library ForceCloseStepsImpl {
	using LockedValuesOps for LockedValues;

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
	 * @notice Refreshes the force-close uPNL/currentPrice snapshot using a fresh PairUpnlAndPriceSig.
	 * @dev Does not modify the previously calculated closePrice.
	 */
	function refreshForceCloseSnapshot(uint256 quoteId, PairUpnlAndPriceSig memory sig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ForceCloseDetail storage detail = accountLayout.forceCloseDetails[quoteId];
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];

		require(detail.inProgress, "ForceActionsFacet: Invalid state");

		LibMuonPartyB.verifyPairUpnlAndPrice(sig, quote.partyB, quote.partyA, quote.symbolId);

		// Ensure partyA solvency for the stored closePrice with this fresh snapshot.
		(, int256 partyAAvailableBalance) = LibForceActions.getAvailableBalancesAfterClose(
			quoteId,
			sig.price,
			sig.upnlPartyA,
			sig.upnlPartyB,
			detail.closePrice
		);
		require(partyAAvailableBalance >= 0, "PartyAFacet: PartyA will be insolvent");

		detail.upnlPartyB = sig.upnlPartyB;
		detail.currentPrice = sig.price;
		detail.timestamp = block.timestamp;
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
				upnlPartyB = LibForceActions.liquidatePartyB(quoteId, detail.closePrice, reservedBalance, detail.upnlPartyB, detail.currentPrice);
				detail.partyBState = PartyBForceCloseState.LIQUIDATED;
			}
		}

		// Clean up
		detail.inProgress = false;
		detail.timestamp = block.timestamp;
		detail.upnlPartyB = 0;
		detail.currentPrice = 0;
	}

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
		bool isMasterAccountMode = accountLayout.masterAccountMode[sig.partyB];
		LibMuonUnifiedSettlement.verifyUnifiedSettlement(sig, isMasterAccountMode);

		// Use the unified settlement function with isForceClose=true
		int256[] memory settleAmountsPerPartyA;
		(newPartyAsAllocatedBalances, settleAmountsPerPartyA) = LibSettlement.settleUpnlUnified(sig, updatedPrices, true);

		// Settlement signatures do not include the force-close quote price/currentPrice, so we only shift uPNL by the
		// realized settlement delta and keep currentPrice unchanged (it should be refreshed via refresh/finalize sig).
		if (isSamePartyB) {
			if (isMasterAccountMode) {
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
