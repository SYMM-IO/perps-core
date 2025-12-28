// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibMuonPartyB } from "../../libraries/muon/LibMuonPartyB.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibQuoteClose } from "../../libraries/LibQuoteClose.sol";
import { LibPartyBQuoteActions } from "../../libraries/LibPartyBQuoteActions.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { QuoteStorage, Quote, QuoteStatus, LockedValues } from "../../storages/QuoteStorage.sol";
import { SingleUpnlSig } from "../../storages/MuonStorage.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { SharedEvents } from "../../libraries/SharedEvents.sol";
import { ISymmioHook } from "../../interfaces/ISymmioHook.sol";

library PartyBQuoteActionsFacetImpl {
	using LockedValuesOps for LockedValues;

	function lockQuote(uint256 quoteId, SingleUpnlSig memory upnlSig) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		address signer = LibSigner.getSigner();

		if (AccountStorage.layout().bindState[quote.partyA].partyB != address(0)) {
			require(AccountStorage.layout().bindState[quote.partyA].partyB == signer, "PartyBFacet: PartyB is not bounded to this partyA");
			require(AccountStorage.layout().isPartyBBindable[signer], "PartyBFacet: PartyB is not bindable");
		} else {
			LibMuonPartyB.verifyPartyBUpnl(upnlSig, signer, quote.partyA);
			int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, quote.partyA);
			require(availableBalance >= 0, "PartyBFacet: Available balance is lower than zero");
			require(uint256(availableBalance) >= quote.lockedValues.totalForPartyB(), "PartyBFacet: insufficient available balance");
		}

		LibPartyBQuoteActions.lockQuote(quoteId);
	}

	function unlockQuote(uint256 quoteId) internal returns (QuoteStatus) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(quote.quoteStatus == QuoteStatus.LOCKED, "PartyBFacet: Invalid state");
		if (block.timestamp > quote.deadline) {
			QuoteStatus result = LibQuoteClose.expireQuote(quoteId);
			return result;
		} else {
			quote.statusModifyTimestamp = block.timestamp;
			quote.quoteStatus = QuoteStatus.PENDING;
			LibAccount.subFromPartyBPendingLockedBalances(quote);
			LibQuote.removeFromPartyBPendingQuotes(quote);
			quoteLayout.partyALockQuotesCount[quote.partyA]--;
			quote.partyB = address(0);
			return QuoteStatus.PENDING;
		}
	}

	function acceptCancelRequest(uint256 quoteId) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = QuoteStorage.layout().quotes[quoteId];
		require(quote.quoteStatus == QuoteStatus.CANCEL_PENDING, "PartyBFacet: Invalid state");
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.CANCELED;
		accountLayout.pendingLockedBalances[quote.partyA].subQuote(quote);
		LibAccount.subFromPartyBPendingLockedBalances(quote);

		// send trading Fee back to partyA
		uint256 fee = LibQuote.getOpenTradingFee(quoteId);
		accountLayout.allocatedBalances[quote.partyA] += fee;
		emit SharedEvents.BalanceChangePartyA(quote.partyA, fee, SharedEvents.BalanceChangeType.PLATFORM_FEE_IN);

		LibQuote.removeFromPendingQuotes(quote);
		QuoteStorage.layout().partyALockQuotesCount[quote.partyA]--;

		address affiliateHook = accountLayout.affiliateHooks[quote.affiliate];
		address systemHook = accountLayout.affiliateHooks[address(0)];

		if (affiliateHook != address(0)) {
			try ISymmioHook(affiliateHook).onCancelQuote(quoteId, quote.partyA, quote.partyB) {} catch {}
		}
		if (systemHook != address(0)) {
			try ISymmioHook(systemHook).onCancelQuote(quoteId, quote.partyA, quote.partyB) {} catch {}
		}
	}
}
