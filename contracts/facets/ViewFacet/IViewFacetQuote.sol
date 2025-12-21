// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../storages/QuoteStorage.sol";

interface IViewFacetQuote {
	struct TotalPositionAmount {
		PositionType positionType;
		uint256 totalOpenAmount;
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

	function getPartyBTotalPositionAmountsBySymbol(address partyB, uint256 symbolId) external view returns (TotalPositionAmount[] memory);

	function getPartyAPendingQuotes(address partyA) external view returns (uint256[] memory);

	function getPartyBPendingQuotes(address partyB, address partyA) external view returns (uint256[] memory);

	function getQuotesWithBitmap(Bitmap calldata bitmap, uint256 gasNeededForReturn) external view returns (Quote[] memory quotes);

	function getNextQuoteId() external view returns (uint256);

	function getQuoteCloseId(uint256 quoteId) external view returns (uint256);

	function getPartyAUPNLParams(
		address partyA,
		uint256 quoteStart,
		uint256 quoteEnd,
		bool getCount
	)
		external
		view
		returns (
			uint256 positionsCount,
			uint256[] memory partyBsAllocated,
			address[] memory partyBs,
			uint256[] memory quoteIds,
			uint256[] memory symbolIds,
			string[] memory symbolNames,
			uint256[] memory openPrices,
			uint256[] memory remainingOpenAmount,
			uint256[] memory positionType
		);

	function getPartyBUPNLParams(
		address partyA,
		address partyB,
		uint256 quoteStart,
		uint256 quoteEnd,
		bool getCount
	)
		external
		view
		returns (
			uint256 positionsCount,
			uint256[] memory partyBsAllocated,
			uint256[] memory quoteIds,
			uint256[] memory symbolIds,
			string[] memory symbolNames,
			uint256[] memory openPrices,
			uint256[] memory remainingOpenAmount,
			uint256[] memory positionType
		);
}
