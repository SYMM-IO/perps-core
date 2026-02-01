// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, LockedValues, QuoteStatus } from "../storages/QuoteStorage.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { CrossPartyBStorage } from "../storages/CrossPartyBStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { LibAccount } from "./LibAccount.sol";
import { LibConnections } from "./LibConnections.sol";
import { LibSigner } from "./LibSigner.sol";
import { LockedValuesOps } from "./LibLockedValues.sol";

library LibPartyBQuoteActions {
	using LockedValuesOps for LockedValues;

	function lockQuote(uint256 quoteId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(quote.quoteStatus == QuoteStatus.PENDING, "PartyBFacet: Invalid state");
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");
		require(quoteId <= quoteLayout.lastId, "PartyBFacet: Invalid quoteId");
		require(LibConnections.isSymbolAllowedForPartyB(signer, quote.symbolId), "PartyBFacet: symbol is not whitelisted");
		require(
			LibConnections.isSymbolAllowedForPartyA(quote.partyA, quote.symbolId),
			"PartyBFacet: Symbol not allowed due to connection restrictions"
		);
		require(!MAStorage.layout().partyBLiquidationStatus[signer][quote.partyA], "PartyBFacet: PartyB isn't solvent");
		require(!CrossPartyBStorage.layout().crossLiquidationDetails[signer].inProgress, "PartyBFacet: PartyB is in cross liquidation process");
		bool isValidPartyB;
		if (quote.partyBsWhiteList.length == 0) {
			require(signer != quote.partyA, "PartyBFacet: PartyA can't be partyB too");
			isValidPartyB = true;
		} else {
			for (uint256 index = 0; index < quote.partyBsWhiteList.length; index++) {
				if (signer == quote.partyBsWhiteList[index]) {
					isValidPartyB = true;
					break;
				}
			}
		}
		require(isValidPartyB, "PartyBFacet: Sender isn't whitelisted");
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.LOCKED;
		quote.partyB = signer;
		
		// lock funds for partyB
		LibAccount.addToPartyBPendingLockedBalances(signer, quote.partyA, quote);
		quoteLayout.partyBPendingQuotes[signer][quote.partyA].push(quote.id);
		quoteLayout.partyALockQuotesCount[quote.partyA]++;
	}
}
