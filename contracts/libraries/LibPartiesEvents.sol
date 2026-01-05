// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { QuoteStatus, OrderType, PositionType, LockedValues } from "../storages/QuoteStorage.sol";

enum ADLReason {
	NOT_IN_CLOSE_STATE,
	PARTY_A_INSUFFICIENT_BALANCE,
	PARTY_B_INSUFFICIENT_BALANCE,
	INVALID_FILLED_AMOUNT
}

/**
 * @notice Event definitions used by PartyB batch actions (adl flows, close requests).
 * @dev Declared in a dedicated library so libraries can emit without local redeclaration.
 */
library LibPartiesEvents {
	event AcceptCancelRequest(uint256 quoteId, QuoteStatus quoteStatus);

	event RequestToClosePosition(
		address partyA,
		address partyB,
		uint256 quoteId,
		uint256 closePrice,
		uint256 quantityToClose,
		OrderType orderType,
		uint256 deadline,
		QuoteStatus quoteStatus,
		uint256 closeId
	);

	event RequestToClosePosition(
		address partyA,
		address partyB,
		uint256 quoteId,
		uint256 closePrice,
		uint256 quantityToClose,
		OrderType orderType,
		uint256 deadline,
		QuoteStatus quoteStatus
	);

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
	);
	event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice); // for backward compatibility
	event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice, LockedValues lockedValues);
	event RequestToCancelCloseRequest(address partyA, address partyB, uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId);
	event AcceptCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId);

	// Close fill events (mirrors IPartiesEvents for backward compatibility)
	event FillCloseRequest(
		uint256 quoteId,
		address partyA,
		address partyB,
		uint256 filledAmount,
		uint256 closedPrice,
		QuoteStatus quoteStatus,
		uint256 closeId
	);
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
	// reason: 1 => insufficient balance for funding + maintenance for partyA, 2 => insufficient for partyB
	event ADLSkip(uint256 quoteId, address partyA, address partyB, ADLReason reason, int256 requiredFundingFee);
	event ADLClose(uint256[] quoteIds, uint256[] amounts, uint256[] prices, uint256 closedAmount);
}
