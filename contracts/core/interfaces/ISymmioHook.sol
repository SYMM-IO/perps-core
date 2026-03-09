// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Hook interface called by Symmio core on trading lifecycle events
interface ISymmioHook {
	/// @notice Whether a trading fee is charged on open or close
	enum TradingFeeType {
		OPEN,
		CLOSE
	}

	/// @notice Called after a position is opened
	/// @param quoteId The quote that was opened
	/// @param filledAmount The quantity filled
	/// @param openedPrice The execution price
	/// @param partyA The trader address
	/// @param partyB The hedger address
	function onOpenPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice, address partyA, address partyB) external;

	/// @notice Called after a position is closed (partially or fully)
	/// @param quoteId The quote that was closed
	/// @param filledAmount The quantity closed
	/// @param closedPrice The execution price
	/// @param partyA The trader address
	/// @param partyB The hedger address
	function onClosePosition(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, address partyA, address partyB) external;

	/// @notice Called after a quote is cancelled
	/// @param quoteId The cancelled quote ID
	/// @param partyA The trader address
	/// @param partyB The hedger address (zero if quote was not locked)
	function onCancelQuote(uint256 quoteId, address partyA, address partyB) external;

	/// @notice Called when a close request is expired or force cancelled and quote returns to OPENED
	/// @param quoteId The quote ID
	/// @param partyA The trader address
	/// @param partyB The hedger address
	function onCloseExpired(uint256 quoteId, address partyA, address partyB) external;

	/// @notice Called when a trading fee is charged for affiliate distribution
	/// @param quoteId The quote the fee relates to
	/// @param amount The fee amount charged
	/// @param partyA The trader address
	/// @param partyB The hedger address
	/// @param symbolId The symbol being traded
	/// @param affiliate The affiliate address receiving fee share
	/// @param feeType Whether this is an open or close fee
	function onFeeCharged(
		uint256 quoteId,
		uint256 amount,
		address partyA,
		address partyB,
		uint256 symbolId,
		address affiliate,
		TradingFeeType feeType
	) external;
}
