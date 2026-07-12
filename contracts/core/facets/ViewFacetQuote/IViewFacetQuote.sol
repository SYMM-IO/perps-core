// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Quote, SolverFeeState } from "../../storages/QuoteStorage.sol";

interface IViewFacetQuote {
	/// @notice A quote represented in the venue's current confirmed unit basis.
	/// @dev `quote` is for valuation and external hedging; Core execution still expects the raw stored quote returned by getQuote.
	struct VenueQuoteView {
		Quote quote;
		uint256 factorApplied;
		uint256 restatementEpoch;
		bool storedInVenueUnits;
		bool symbolFrozen;
	}

	struct Bitmap {
		uint256 size;
		BitmapElement[] elements;
	}

	struct BitmapElement {
		uint256 offset;
		uint256 bitmap;
	}

	function getQuote(uint256 quoteId) external view returns (Quote memory);

	function getQuoteInVenueUnits(uint256 quoteId) external view returns (VenueQuoteView memory);

	function getQuotesInVenueUnits(uint256[] calldata quoteIds) external view returns (VenueQuoteView[] memory);

	function getSolverFeeState(uint256 quoteId) external view returns (SolverFeeState memory);

	function getQuotesByParent(uint256 quoteId, uint256 size) external view returns (Quote[] memory);

	function quoteIdsOf(address partyA, uint256 start, uint256 size) external view returns (uint256[] memory);

	function getQuotes(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	function quotesLength(address user) external view returns (uint256);

	function partyAPositionsCount(address partyA) external view returns (uint256);

	function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getPartyBOpenPositions(address partyB, address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getOpenPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory);

	function getActivePositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory);

	function partyBPositionsCount(address partyB, address partyA) external view returns (uint256);

	function getPartyAPendingQuotes(address partyA) external view returns (uint256[] memory);

	function partyAPendingQuotesCount(address partyA) external view returns (uint256);

	function getPartyBPendingQuotes(address partyB, address partyA) external view returns (uint256[] memory);

	function getQuotesWithBitmap(Bitmap calldata bitmap, uint256 gasNeededForReturn) external view returns (Quote[] memory quotes);

	function getNextQuoteId() external view returns (uint256);

	function getQuoteCloseId(uint256 quoteId) external view returns (uint256);

	function getQuoteFundingDebts(uint256[] memory quoteIds) external view returns (int256[] memory debts);

	function getSumQuoteFundingDebts(uint256[] memory quoteIds) external view returns (int256 sum);
}
