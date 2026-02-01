// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

enum PositionType {
	LONG,
	SHORT
}

enum OrderType {
	LIMIT,
	MARKET
}

enum QuoteStatus {
	PENDING, //0
	LOCKED, //1
	CANCEL_PENDING, //2
	CANCELED, //3
	OPENED, //4
	CLOSE_PENDING, //5
	CANCEL_CLOSE_PENDING, //6
	CLOSED, //7
	LIQUIDATED, //8
	EXPIRED, //9
	LIQUIDATED_PENDING //10
}

struct LockedValues {
	uint256 cva;
	uint256 lf;
	uint256 partyAmm;
	uint256 partyBmm;
}

struct Quote {
	uint256 id;
	address[] partyBsWhiteList;
	uint256 symbolId;
	PositionType positionType;
	OrderType orderType;
	uint256 openedPrice;
	uint256 initialOpenedPrice;
	uint256 requestedOpenPrice;
	uint256 marketPrice;
	uint256 quantity;
	uint256 closedAmount;
	LockedValues initialLockedValues;
	LockedValues lockedValues;
	uint256 maxFundingRate;
	address partyA;
	address partyB;
	QuoteStatus quoteStatus;
	uint256 avgClosedPrice;
	uint256 requestedClosePrice;
	uint256 quantityToClose;
	uint256 parentId;
	uint256 createTimestamp;
	uint256 statusModifyTimestamp;
	uint256 lastFundingPaymentTimestamp;
	uint256 deadline;
	uint256 tradingFee;
	address affiliate;
	int256 accumulatedPaidFunding;
	uint256 closeFee;
	bytes data;
}

struct Fee {
	uint256 openFee;
	uint256 closeFee;
	bool isSet;
}

/// @title QuoteStorage
/// @notice All quote/position data and aggregated metrics for efficient calculations
library QuoteStorage {
	bytes32 internal constant QUOTE_STORAGE_SLOT = keccak256("diamond.standard.storage.quote");

	struct Layout {
		/// @notice All quote IDs created by each user
		/// @dev Historical record of every quote a PartyA has ever created. Used for
		///      querying user's trading history. Only grows, never shrinks.
		mapping(address => uint256[]) quoteIdsOf;
		/// @notice The actual Quote data keyed by quote ID
		/// @dev The source of truth for all position data.
		mapping(uint256 => Quote) quotes;
		/// @notice Count of open positions per PartyA
		/// @dev Used for quick checks like "does this user have any positions?".
		mapping(address => uint256) partyAPositionsCount;
		/// @notice Count of open positions per PartyB-PartyA pair, plus global totals
		/// @dev Maps partyB => partyA => count for per-counterparty tracking.
		///      Additionally, partyB => address(0) always tracks total positions
		///      across all PartyAs, used for cross PartyB operations.
		mapping(address => mapping(address => uint256)) partyBPositionsCount;
		/// @notice Quote IDs not yet opened per PartyA
		/// @dev Contains quotes in PENDING, LOCKED, or CANCEL_PENDING status. Removed
		///      when opened, canceled, or expired. Used to iterate pending orders.
		mapping(address => uint256[]) partyAPendingQuotes;
		/// @notice Quote IDs that PartyB has locked per PartyA
		/// @dev Maps partyB => partyA => quoteIds[]. Added when PartyB locks a quote,
		///      removed when quote opens or is canceled. Contains LOCKED or CANCEL_PENDING.
		mapping(address => mapping(address => uint256[])) partyBPendingQuotes;
		/// @notice Active position quote IDs per PartyA
		/// @dev Added when quote opens, removed when closes/liquidates. Contains quotes
		///      with OPENED, CLOSE_PENDING, CANCEL_CLOSE_PENDING, or LIQUIDATED_PENDING.
		mapping(address => uint256[]) partyAOpenPositions;
		/// @notice Index of each quote in partyAOpenPositions array
		/// @dev Enables O(1) removal from partyAOpenPositions by swapping with last element.
		///      Maps quoteId => index in array. Must stay in sync with the array.
		mapping(uint256 => uint256) partyAPositionsIndex;
		/// @notice Active position quote IDs per PartyB-PartyA pair
		/// @dev Maps partyB => partyA => quoteIds[]. Same statuses as partyAOpenPositions.
		mapping(address => mapping(address => uint256[])) partyBOpenPositions;
		/// @notice Index of each quote in partyBOpenPositions array
		/// @dev Same as partyAPositionsIndex but for PartyB arrays. Enables O(1) removal.
		mapping(uint256 => uint256) partyBPositionsIndex;
		/// @notice Auto-incrementing counter for quote IDs
		/// @dev Initialized to 0 (Solidity default). First quote gets ID 1 via ++lastId.
		///      Never decreases. ID 0 is never assigned, so it can be used as "null"
		///      or "not found" in mappings and comparisons.
		uint256 lastId;
		/// @notice Auto-incrementing counter for close operation IDs
		/// @dev Each close request gets a unique ID for tracking and event correlation.
		uint256 lastCloseId;
		/// @notice Maps quote ID to its current close operation ID
		/// @dev When a close is requested, this links the quote to its close ID.
		///      Used to match close events to specific close requests.
		mapping(uint256 => uint256) closeIds;
		/// @notice Count of quotes PartyA has that are locked by PartyB
		/// @dev Tracks quotes in LOCKED or CANCEL_PENDING status. Incremented when
		///      PartyB locks, decremented when opened/unlocked/cancelled by PartyB.
		mapping(address => uint256) partyALockQuotesCount;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = QUOTE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
