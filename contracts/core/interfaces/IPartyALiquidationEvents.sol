// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IPartyALiquidationEvents {
	event LiquidatePartyA(address liquidator, address partyA, uint256 allocatedBalance, int256 upnl, int256 totalUnrealizedLoss, bytes liquidationId);
	event DeferredLiquidatePartyA(
		address liquidator,
		address partyA,
		uint256 allocatedBalance,
		int256 upnl,
		int256 totalUnrealizedLoss,
		bytes liquidationId,
		uint256 liquidationBlockNumber,
		uint256 liquidationTimestamp,
		uint256 liquidationAllocatedBalance
	);
	event LiquidatePositionsPartyA(
		address liquidator,
		address partyA,
		uint256[] quoteIds,
		uint256[] liquidatedAmounts,
		uint256[] closeIds,
		bytes liquidationId
	);
	event LiquidatePositionsPartyA(
		address liquidator,
		address partyA,
		uint256[] quoteIds,
		uint256[] liquidatedAmounts,
		uint256[] closeIds,
		uint256[] averageClosedPrices,
		bytes liquidationId
	);
	event LiquidatePendingPositionsPartyA(address liquidator, address partyA, uint256[] quoteIds, uint256[] liquidatedAmounts, bytes liquidationId);
	event SettlePartyALiquidation(address partyA, address[] partyBs, int256[] amounts, bytes liquidationId);
	/// @notice Extended settlement event exposing the exact PartyB allocation keys and CVA releases.
	/// @dev Array values at index `i` belong to `partyBs[i]`. The legacy overload above is still emitted for compatibility.
	event SettlePartyALiquidation(
		address partyA,
		address[] partyBs,
		address[] allocationKeys,
		int256[] amounts,
		uint256[] cvaAmounts,
		bytes liquidationId
	);
	event LiquidationDisputed(address partyA, bytes liquidationId);
	event ResolveLiquidationDispute(address partyA, address[] partyBs, int256[] amounts, bool disputed, bytes liquidationId);
	event FullyLiquidatedPartyA(address partyA, bytes liquidationId);
	/// @notice Raw funding and price PnL calculated while one quote is liquidated.
	/// @dev Both values are signed from PartyB's perspective: positive means PartyB receives, negative means PartyB pays.
	///      Observers combine these records with `LiquidationFundingSettled` for the same PartyA, PartyB, and liquidationId.
	event QuoteLiquidationFundingCalculated(
		address indexed partyA,
		address indexed partyB,
		uint256 indexed quoteId,
		uint256 symbolId,
		int256 rawFunding,
		int256 rawPnl,
		bytes liquidationId
	);
	/// @notice Raw and final aggregate funding and price PnL for one PartyA/PartyB liquidation settlement.
	/// @dev All four amounts are signed from PartyB's perspective. `settledFunding` and `settledPnl` are the exact typed
	///      components applied to PartyB's balance, and their sum equals PartyB's final net settlement balance delta.
	///      `scaleNumerator / scaleDenominator` is the exact factor used to derive `settledFunding` from `rawFunding`;
	///      `settledPnl` is the residual price-PnL component and is not independently scaled. The denominator is never zero.
	event LiquidationFundingSettled(
		address indexed partyA,
		address indexed partyB,
		address indexed allocationKey,
		int256 rawFunding,
		int256 settledFunding,
		int256 rawPnl,
		int256 settledPnl,
		uint256 scaleNumerator,
		uint256 scaleDenominator,
		bytes liquidationId
	);
	/// @notice Marks quote-level normal-liquidation funding as superseded by Clearing House settlement components.
	event LiquidationFundingSettlementAbandoned(address indexed partyA, address indexed partyB, int256 rawFunding, bytes liquidationId);
	event SetSymbolsPrices(address liquidator, address partyA, uint256[] symbolIds, uint256[] prices, bytes liquidationId);
	event SetPartyALiquidationSnapshot(
		address liquidator,
		address partyA,
		address[] partyBs,
		uint256[] symbolIds,
		uint256[] prices,
		int256[] cumulativeLongFees,
		int256[] cumulativeShortFees,
		bytes liquidationId
	);
	event DisputeForLiquidation(address liquidator, address partyA, bytes liquidationId);
	event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);
}
