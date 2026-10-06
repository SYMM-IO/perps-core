// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStatus } from "../../storages/QuoteStorage.sol";

interface ForceActionsFacetEvents {
	event ForceCancelQuote(uint256 quoteId, QuoteStatus quoteStatus);
	event ForceCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId);
	event ForceCloseInitialized(
		address indexed initiator,
		address indexed partyB,
		uint256 quoteId,
		bytes highLowPriceSigId,
		uint256 closePrice,
		uint256 timestamp
	);
	event ForceClosePosition(
		uint256 quoteId,
		address partyA,
		address partyB,
		uint256 filledAmount,
		uint256 closedPrice,
		QuoteStatus quoteStatus,
		uint256 closeId
	);
	/// @notice Emitted when a cross-partyB force close completes by closing the position *ignoring* partyB uPNL.
	/// @dev This means partyB could not remain solvent when accounting for uPNL at `currentPrice`.
	event ForceClosePartyBInsolvent(
		uint256 quoteId,
		address partyA,
		address partyB,
		uint256 closedPrice,
		uint256 currentPrice,
		int256 upnlPartyB,
		int256 partyBAvailableAfterClose
	);
	event ForceFetchAllocated(address partyB, address[] partyAs, uint256[] FetchedAmount, uint256[] newPartyBsAllocatedBalances);
}
