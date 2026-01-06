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
import { HighLowPriceSig, UnifiedSettlementSig } from "../../storages/MuonStorage.sol";
import { LibMuonUnifiedSettlement } from "../../libraries/muon/LibMuonUnifiedSettlement.sol";

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
