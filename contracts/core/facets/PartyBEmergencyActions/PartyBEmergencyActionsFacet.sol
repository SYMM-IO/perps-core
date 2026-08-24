// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PartyBEmergencyActionsFacetImpl } from "./PartyBEmergencyActionsFacetImpl.sol";
import { IPartyBEmergencyActionsFacet } from "./IPartyBEmergencyActionsFacet.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { QuoteStorage, Quote } from "../../storages/QuoteStorage.sol";
import { PairUpnlAndPriceSig } from "../../storages/MuonStorage.sol";
import { LibQuote } from "../../libraries/LibQuote.sol";
import { LibPartiesEvents } from "../../libraries/LibPartiesEvents.sol";

contract PartyBEmergencyActionsFacet is Accessibility, Pausable, IPartyBEmergencyActionsFacet {
	/// @notice Allows Party B to fully close a position during a configured emergency or when adjustment rounding makes it unrestatable.
	/// @dev The adjustment-dust exception applies while the symbol is frozen. The Muon signature must use the quote's current stored basis.
	/// @param quoteId The ID of the quote for which the position is emergency closed.
	/// @param upnlSig The Muon signature containing the unrealized profit and loss (UPNL) and the closing price.
	function emergencyClosePosition(
		uint256 quoteId,
		PairUpnlAndPriceSig memory upnlSig
	) external whenNotPartyBActionsPaused onlyPartyBOfQuote(quoteId) notLiquidated(quoteId) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		uint256 filledAmount = LibQuote.quoteOpenAmount(quote);
		PartyBEmergencyActionsFacetImpl.emergencyClosePosition(quoteId, upnlSig);
		emit EmergencyClosePosition(
			quoteId,
			quote.partyA,
			quote.partyB,
			filledAmount,
			upnlSig.price,
			quote.quoteStatus,
			quoteLayout.closeIds[quoteId]
		);
	}

	/// @notice Performs ADL close for a quote on a symbol
	/// @dev Uses PartyBEmergencyActionsFacetImpl to handle balance checks, nonce bumps, and quote status/closeId management.
	/// @param quoteId Quote to ADL close
	/// @param amount Quantity to close.
	/// @param price Execution price.
	function adlClose(uint256 quoteId, uint256 amount, uint256 price) external whenNotPartyBActionsPaused {
		PartyBEmergencyActionsFacetImpl.adlClose(quoteId, amount, price);
		emit LibPartiesEvents.ADLClose(quoteId, amount, price);
	}
}
