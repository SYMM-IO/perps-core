// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../storages/QuoteStorage.sol";
import "../storages/MAStorage.sol";
import "../storages/SymbolStorage.sol";
import "./LibAccount.sol";
import "./LibConnections.sol";
import "./LibSigner.sol";

library LibPartyBQuoteActions {
	using LockedValuesOps for LockedValues;

	function lockQuote(uint256 quoteId) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		Quote storage quote = quoteLayout.quotes[quoteId];
		require(quote.quoteStatus == QuoteStatus.PENDING, "PartyBFacet: Invalid state");
		require(block.timestamp <= quote.deadline, "PartyBFacet: Quote is expired");
		require(quoteId <= quoteLayout.lastId, "PartyBFacet: Invalid quoteId");
		require(
			LibConnections.isSymbolAllowedForPartyB(LibSigner.getSigner(), quote.symbolId),
			"PartyBFacet: symbol is not whitelisted"
		);
		require(
			LibConnections.isSymbolAllowedForPartyA(quote.partyA, quote.symbolId),
			"PartyBFacet: Symbol not allowed due to connection restrictions"
		);
		require(!MAStorage.layout().partyBLiquidationStatus[LibSigner.getSigner()][quote.partyA], "PartyBFacet: PartyB isn't solvent");
		require(!accountLayout.crossLiquidationDetails[LibSigner.getSigner()].inProgress, "PartyBFacet: PartyB is in cross liquidation process");
		bool isValidPartyB;
		if (quote.partyBsWhiteList.length == 0) {
			require(LibSigner.getSigner() != quote.partyA, "PartyBFacet: PartyA can't be partyB too");
			isValidPartyB = true;
		} else {
			for (uint256 index = 0; index < quote.partyBsWhiteList.length; index++) {
				if (LibSigner.getSigner() == quote.partyBsWhiteList[index]) {
					isValidPartyB = true;
					break;
				}
			}
		}
		require(isValidPartyB, "PartyBFacet: Sender isn't whitelisted");
		quote.statusModifyTimestamp = block.timestamp;
		quote.quoteStatus = QuoteStatus.LOCKED;
		quote.partyB = LibSigner.getSigner();
		// lock funds for partyB
		accountLayout.partyBPendingLockedBalances[LibSigner.getSigner()][quote.partyA].addQuote(quote);
		quoteLayout.partyBPendingQuotes[LibSigner.getSigner()][quote.partyA].push(quote.id);
	}
}
