// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStatus, PositionType, OrderType, LockedValues } from "../storages/QuoteStorage.sol";

/// @notice Events emitted by PartyA and PartyB trading actions
interface IPartiesEvents {
	/// @notice Emitted when a PartyB accepts a cancel request on a locked quote
	event AcceptCancelRequest(uint256 quoteId, QuoteStatus quoteStatus);

	/// @notice Emitted when a PartyA sends a new quote (legacy format for backward compatibility)
	event SendQuote(
		address partyA,
		uint256 quoteId,
		address[] partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 marketPrice,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 tradingFee,
		uint256 deadline
	); // for backward compatibility

	/// @notice Emitted when a PartyA sends a new quote (current format with encoded params)
	// paramsData is abi.encode(symbolId, positionType, orderType, price, marketPrice, quantity, cva, lf, partyAmm, partyBmm, tradingFee, deadline)
	event SendQuote(address partyA, uint256 quoteId, address[] partyBsWhiteList, address affiliate, bytes paramsData, bytes data);

	/// @notice Emitted when a pending quote expires before being locked
	event ExpireQuoteOpen(QuoteStatus quoteStatus, uint256 quoteId);

	/// @notice Emitted when a close request expires before being filled
	event ExpireQuoteClose(QuoteStatus quoteStatus, uint256 quoteId, uint256 closeId);

	/// @notice Emitted when a position is opened (legacy format for backward compatibility)
	event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice); // for backward compatibility
	/// @notice Emitted when a position is opened (current format with locked values)
	event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice, LockedValues lockedValues);

	/// @notice Emitted when a close request is filled (legacy format for backward compatibility)
	event FillCloseRequest(
		uint256 quoteId,
		address partyA,
		address partyB,
		uint256 filledAmount,
		uint256 closedPrice,
		QuoteStatus quoteStatus,
		uint256 closeId
	); // for backward compatibility
	/// @notice Emitted when a close request is filled (current format with locked values)
	event FillCloseRequest(
		uint256 quoteId,
		address partyA,
		address partyB,
		uint256 filledAmount,
		uint256 closedPrice,
		QuoteStatus quoteStatus,
		uint256 closeId,
		LockedValues lockedValues
	);

	/// @notice Emitted when a PartyB is liquidated against a specific PartyA
	event LiquidatePartyB(address liquidator, address partyB, address partyA, uint256 partyBAllocatedBalance, int256 upnl);
}
