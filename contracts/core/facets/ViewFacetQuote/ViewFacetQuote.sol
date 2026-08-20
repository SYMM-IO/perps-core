// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStorage, Quote, QuoteStatus, SolverFeeState } from "../../storages/QuoteStorage.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment } from "../../storages/SymbolAdjustmentStorage.sol";
import { IViewFacetQuote } from "./IViewFacetQuote.sol";
import { LibQuoteFunding } from "../../libraries/LibQuoteFunding.sol";
import { LibQuoteAdjustment } from "../../libraries/LibQuoteAdjustment.sol";
import { LibSymbolAdjustment } from "../../libraries/LibSymbolAdjustment.sol";

contract ViewFacetQuote is IViewFacetQuote {
	/// @notice Returns the details of a quote by its ID.
	/// @param quoteId The ID of the quote.
	/// @return The details of the quote.
	function getQuote(uint256 quoteId) external view returns (Quote memory) {
		return QuoteStorage.layout().quotes[quoteId];
	}

	/// @notice Returns a quote normalized to the venue basis selected by the active factor or frozen restatement window.
	/// @dev The normalized values are intended for valuation, display, and external hedging. Core execution calls still expect raw stored units.
	function getQuoteInVenueUnits(uint256 quoteId) external view returns (VenueQuoteView memory) {
		return _getQuoteInVenueUnits(quoteId);
	}

	/// @notice Returns quotes normalized to venue units from one atomic on-chain snapshot.
	/// @dev During restatement, already-restated quotes are unchanged while remaining quotes receive the window's restatement factor. This also
	///      supports direct restatement, where the scheduled factor is never activated for Muon or normal trading.
	function getQuotesInVenueUnits(uint256[] calldata quoteIds) external view returns (VenueQuoteView[] memory quotes) {
		quotes = new VenueQuoteView[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) quotes[i] = _getQuoteInVenueUnits(quoteIds[i]);
	}

	function _getQuoteInVenueUnits(uint256 quoteId) internal view returns (VenueQuoteView memory result) {
		Quote memory quote = QuoteStorage.layout().quotes[quoteId];
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[quote.symbolId];
		bool restatedInCurrentWindow = adjustment.restating && adjustmentLayout.quoteRestatedEpoch[quoteId] == adjustment.restatementEpoch;
		uint256 factor =
			restatedInCurrentWindow
				? 1e18
				: adjustment.restating
					? adjustment.restatementFactor
					: LibSymbolAdjustment.activeCumulativeFactor(quote.symbolId);

		result.quote = LibQuoteAdjustment.toVenueUnits(quote, factor);
		result.factorApplied = factor;
		result.restatementEpoch = adjustment.restatementEpoch;
		result.storedInVenueUnits = factor == 1e18;
		result.symbolFrozen = LibSymbolAdjustment.isFrozen(quote.symbolId);
	}

	/// @notice Returns solver fee caps and charged amounts for a quote.
	/// @param quoteId The ID of the quote.
	/// @return The solver fee state for the quote.
	function getSolverFeeState(uint256 quoteId) external view returns (SolverFeeState memory) {
		return QuoteStorage.layout().solverFeeStates[quoteId];
	}

	/// @notice Returns quotes by following the parentId chain.
	/// @dev Each quote's parentId points to the child or remainder quote created from a partial fill.
	/// @param quoteId The starting quote ID.
	/// @param size The maximum number of quotes to return.
	/// @return An array of quotes.
	function getQuotesByParent(uint256 quoteId, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		Quote memory quote = quoteLayout.quotes[quoteId];
		quotes[0] = quote;
		for (uint256 i = 1; i < size; i++) {
			if (quote.parentId == 0) {
				break;
			}
			quote = quoteLayout.quotes[quote.parentId];
			quotes[i] = quote;
		}
		return quotes;
	}

	/// @notice Returns an array of quote IDs associated with a party A address.
	/// @param partyA The address of party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of quote IDs.
	function quoteIdsOf(address partyA, uint256 start, uint256 size) external view returns (uint256[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.quoteIdsOf[partyA].length < start + size) {
			size = quoteLayout.quoteIdsOf[partyA].length - start;
		}
		uint256[] memory quoteIds = new uint256[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			quoteIds[i - start] = quoteLayout.quoteIdsOf[partyA][i];
			unchecked {
				++i;
			}
		}
		return quoteIds;
	}

	/// @notice Returns an array of quotes associated with a party A address.
	/// @param partyA The address of party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of quotes.
	function getQuotes(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		if (quoteLayout.quoteIdsOf[partyA].length < start + size) {
			size = quoteLayout.quoteIdsOf[partyA].length - start;
		}
		Quote[] memory quotes = new Quote[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			quotes[i - start] = quoteLayout.quotes[quoteLayout.quoteIdsOf[partyA][i]];
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/// @notice Returns the length of the quotes array associated with a user.
	/// @param user The address of the user.
	/// @return The length of the quotes array.
	function quotesLength(address user) external view returns (uint256) {
		return QuoteStorage.layout().quoteIdsOf[user].length;
	}

	/// @notice Returns the number of open positions associated with a party A address.
	/// @param partyA The address of party A.
	/// @return The number of open positions.
	function partyAPositionsCount(address partyA) external view returns (uint256) {
		return QuoteStorage.layout().partyAPositionsCount[partyA];
	}

	/// @notice Internal: Returns an array of open positions associated with a party A address.
	/// @param partyA The address of party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of open positions.
	function getPartyAOpenPositionsImp(address partyA, uint256 start, uint256 size) internal view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();

		uint256[] memory partyAOpenPositions = quoteLayout.partyAOpenPositions[partyA];
		if (partyAOpenPositions.length < start + size) size = partyAOpenPositions.length - start;

		Quote[] memory quotes = new Quote[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			quotes[i - start] = quoteLayout.quotes[partyAOpenPositions[i]];
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/// @notice Returns an array of open positions associated with a party A address.
	/// @param partyA The address of party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of open positions.
	function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory) {
		return getPartyAOpenPositionsImp(partyA, start, size);
	}

	/// @notice Internal: Returns an array of open positions associated with a party B address and a specific party A address.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of open positions.
	function getPartyBOpenPositionsImp(address partyB, address partyA, uint256 start, uint256 size) internal view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		uint256[] memory partyBOpenPositions = quoteLayout.partyBOpenPositions[partyB][partyA];
		if (partyBOpenPositions.length < start + size) size = partyBOpenPositions.length - start;

		Quote[] memory quotes = new Quote[](size);
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			quotes[i - start] = quoteLayout.quotes[partyBOpenPositions[i]];
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/// @notice Returns an array of open positions associated with a party B address and a specific party A address.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of open positions.
	function getPartyBOpenPositions(address partyB, address partyA, uint256 start, uint256 size) external view returns (Quote[] memory) {
		return getPartyBOpenPositionsImp(partyB, partyA, start, size);
	}

	/// @notice Returns an array of positions associated with a party B address.
	/// @param partyB The address of party B.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of positions.
	function getPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		uint j = 0;
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			Quote memory quote = quoteLayout.quotes[i];
			if (quote.partyB == partyB) {
				quotes[j] = quote;
				j += 1;
			}
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/// @notice Returns an array of open positions associated with a party B address.
	/// @param partyB The address of party B.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of open positions.
	function getOpenPositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		uint j = 0;
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			Quote memory quote = quoteLayout.quotes[i];
			if (
				quote.partyB == partyB &&
				(quote.quoteStatus == QuoteStatus.OPENED ||
					quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
					quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING)
			) {
				quotes[j] = quote;
				j += 1;
			}
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/// @notice Returns an array of active positions associated with a party B address.
	/// @param partyB The address of party B.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of active positions.
	function getActivePositionsFilteredByPartyB(address partyB, uint256 start, uint256 size) external view returns (Quote[] memory) {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote[] memory quotes = new Quote[](size);
		uint j = 0;
		uint256 end = start + size;
		for (uint256 i = start; i < end;) {
			Quote memory quote = quoteLayout.quotes[i];
			if (
				quote.partyB == partyB &&
				quote.quoteStatus != QuoteStatus.CANCELED &&
				quote.quoteStatus != QuoteStatus.CLOSED &&
				quote.quoteStatus != QuoteStatus.EXPIRED &&
				quote.quoteStatus != QuoteStatus.LIQUIDATED
			) {
				quotes[j] = quote;
				j += 1;
			}
			unchecked {
				++i;
			}
		}
		return quotes;
	}

	/// @notice Returns the number of positions associated with a party B address and a specific party A address.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @return The number of positions.
	function partyBPositionsCount(address partyB, address partyA) external view returns (uint256) {
		return QuoteStorage.layout().partyBPositionsCount[partyB][partyA];
	}

	/// @notice Returns an array of pending quotes associated with a party A address.
	/// @param partyA The address of party A.
	/// @return An array of pending quotes.
	function getPartyAPendingQuotes(address partyA) external view returns (uint256[] memory) {
		return QuoteStorage.layout().partyAPendingQuotes[partyA];
	}

	/// @notice Returns the number of pending quotes for a party A (single SLOAD, cheaper than getPartyAPendingQuotes).
	/// @param partyA The address of party A.
	/// @return The number of pending quotes.
	function partyAPendingQuotesCount(address partyA) external view returns (uint256) {
		return QuoteStorage.layout().partyAPendingQuotes[partyA].length;
	}

	/// @notice Returns an array of pending quotes associated with a party B address and a specific party A address.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @return An array of pending quotes.
	function getPartyBPendingQuotes(address partyB, address partyA) external view returns (uint256[] memory) {
		return QuoteStorage.layout().partyBPendingQuotes[partyB][partyA];
	}

	/// @notice Retrieves a filtered list of quotes based on a bitmap. The method returns quotes only if sufficient gas remains.
	/// @param bitmap Selects quotes by position. Each element contains an offset and a 256-bit selection map.
	/// @param gasNeededForReturn Gas reserved to complete execution and return the data. Retrieval stops before
	///                           consuming this reserve.
	/// @return quotes An array of `Quote` structures, each corresponding to a quote identified by the bitmap.
	function getQuotesWithBitmap(Bitmap calldata bitmap, uint256 gasNeededForReturn) external view returns (Quote[] memory quotes) {
		QuoteStorage.Layout storage qL = QuoteStorage.layout();

		quotes = new Quote[](bitmap.size);
		uint256 quoteIndex = 0;

		for (uint256 i = 0; i < bitmap.elements.length; ++i) {
			uint256 bits = bitmap.elements[i].bitmap;
			uint256 offset = bitmap.elements[i].offset;
			while (bits > 0 && gasleft() > gasNeededForReturn) {
				if ((bits & 1) > 0) {
					quotes[quoteIndex] = qL.quotes[offset];
					++quoteIndex;
				}
				++offset;
				bits >>= 1;
			}
		}
	}

	/// @notice Retrieves the last assigned quote ID.
	/// @return The last assigned quote ID.
	function getNextQuoteId() external view returns (uint256) {
		return QuoteStorage.layout().lastId;
	}

	/// @notice Retrieves the close ID of a quote.
	/// @param quoteId The ID of the quote.
	/// @return The close ID of the quote.
	function getQuoteCloseId(uint256 quoteId) external view returns (uint256) {
		return QuoteStorage.layout().closeIds[quoteId];
	}

	/// @notice Gets the funding debt for a list of quotes
	/// @dev Returns the funding debt each quote should pay (positive) or receive (negative)
	/// @param quoteIds Array of quote IDs to calculate funding debts for
	/// @return debts Array of funding debts in the same order as quoteIds
	function getQuoteFundingDebts(uint256[] memory quoteIds) external view returns (int256[] memory debts) {
		debts = new int256[](quoteIds.length);
		for (uint256 i = 0; i < quoteIds.length; i++) debts[i] = LibQuoteFunding.getAccumulatedFundingFee(quoteIds[i]);
		return debts;
	}

	/// @notice Gets the sum of funding debts for a list of quotes
	/// @dev Returns the sum of funding debts
	/// @param quoteIds Array of quote IDs to calculate funding debts for
	/// @return The sum of all funding debts
	function getSumQuoteFundingDebts(uint256[] memory quoteIds) external view returns (int256) {
		int256 sum;
		for (uint256 i = 0; i < quoteIds.length; i++) sum += LibQuoteFunding.getAccumulatedFundingFee(quoteIds[i]);
		return sum;
	}
}
