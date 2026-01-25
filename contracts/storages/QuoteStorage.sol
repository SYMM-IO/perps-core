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
	// Price of quote which PartyB opened in 18 decimals
	uint256 openedPrice;
	uint256 initialOpenedPrice;
	// Price of quote which PartyA requested in 18 decimals
	uint256 requestedOpenPrice;
	uint256 marketPrice;
	// Quantity of quote which PartyA requested in 18 decimals
	uint256 quantity;
	// Quantity of quote which PartyB has closed until now in 18 decimals
	uint256 closedAmount;
	LockedValues initialLockedValues;
	LockedValues lockedValues;
	uint256 maxFundingRate; // NOTE: Funding caps postponed to a later version. Field kept for compatibility.
	address partyA;
	address partyB;
	QuoteStatus quoteStatus;
	uint256 avgClosedPrice;
	uint256 requestedClosePrice;
	uint256 quantityToClose;
	// handle partially open position
	uint256 parentId;
	uint256 createTimestamp;
	uint256 statusModifyTimestamp;
	uint256 lastFundingPaymentTimestamp;
	uint256 deadline;
	uint256 tradingFee; // openFee
	address affiliate;
	int256 accumulatedPaidFunding;
	uint256 closeFee;
	bytes data;
}

struct Fee {
	uint256 openFee;
	uint256 closeFee;
	bool isSet; // true if the fee is explicitly set, false if default (unset/zero)
}

struct PartiesAggregatedPositions {
	uint256 aggregatedAmount;
	uint256 aggregatedNotional;
}

// Aggregate funding tracking: Σ(openAmount × accumulatedPaidFunding) for all open quotes
// This enables O(symbols) funding debt calculation instead of O(quotes)
struct PartiesAggregatedFunding {
	int256 weightedPaidFunding; // Σ(openAmount × accumulatedPaidFunding / 1e18)
}

library QuoteStorage {
	bytes32 internal constant QUOTE_STORAGE_SLOT = keccak256("diamond.standard.storage.quote");

	struct Layout {
		mapping(address => uint256[]) quoteIdsOf;
		mapping(uint256 => Quote) quotes;
		mapping(address => uint256) partyAPositionsCount;
		mapping(address => mapping(address => uint256)) partyBPositionsCount; // partyB => partyA => count of positions, partyA = address(0) for master account mode
		mapping(address => uint256[]) partyAPendingQuotes;
		mapping(address => mapping(address => uint256[])) partyBPendingQuotes;
		mapping(address => uint256[]) partyAOpenPositions;
		mapping(uint256 => uint256) partyAPositionsIndex;
		mapping(address => mapping(address => uint256[])) partyBOpenPositions;
		mapping(uint256 => uint256) partyBPositionsIndex;
		uint256 lastId;
		uint256 lastCloseId;
		mapping(uint256 => uint256) closeIds;
		mapping(address => uint256) partyALockQuotesCount;
		// Global partyB aggregated positions (for master account mode UPNL calculations across all partyAs)
		mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedPositions))) partyBAggregatedPositions; // partyB => symbolId => positionType
		// Per-counterparty aggregated positions (for UPNL calculations with per-hedger funding rates)
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedPositions)))) partyBAggregatedPositionsPerPartyA; // partyB => partyA => symbolId => positionType
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedPositions)))) partyAAggregatedPositionsPerPartyB; // partyA => partyB => symbolId => positionType
		// Global partyB aggregate funding tracking (for master account mode UPNL calculations across all partyAs)
		mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedFunding))) partyBAggregatedFunding; // partyB => symbolId => positionType
		// Per-counterparty aggregate funding tracking
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedFunding)))) partyAAggregatedFundingPerPartyB; // partyA => partyB => symbolId => positionType
		mapping(address => mapping(address => mapping(uint256 => mapping(PositionType => PartiesAggregatedFunding)))) partyBAggregatedFundingPerPartyA; // partyB => partyA => symbolId => positionType
		// Global partyB active symbols (for master account mode iteration across all partyAs)
		mapping(address => uint256[]) partyBActiveSymbols; // partyB => symbolId[]
		mapping(address => mapping(uint256 => uint256)) partyBActiveSymbolsIndex; // partyB => symbolId => index+1 (0 = not active)
		// Per-counterparty active symbols tracking for efficient iteration
		mapping(address => mapping(address => uint256[])) partyAActiveSymbolsPerPartyB; // partyA => partyB => symbolId[]
		mapping(address => mapping(address => mapping(uint256 => uint256))) partyAActiveSymbolsIndexPerPartyB; // partyA => partyB => symbolId => index+1 (0 = not active)
		mapping(address => mapping(address => uint256[])) partyBActiveSymbolsPerPartyA; // partyB => partyA => symbolId[]
		mapping(address => mapping(address => mapping(uint256 => uint256))) partyBActiveSymbolsIndexPerPartyA; // partyB => partyA => symbolId => index+1 (0 = not active)
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = QUOTE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
