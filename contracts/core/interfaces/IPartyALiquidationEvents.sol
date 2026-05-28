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
	event LiquidationDisputed(address partyA, bytes liquidationId);
	event ResolveLiquidationDispute(address partyA, address[] partyBs, int256[] amounts, bool disputed, bytes liquidationId);
	event FullyLiquidatedPartyA(address partyA, bytes liquidationId);
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
