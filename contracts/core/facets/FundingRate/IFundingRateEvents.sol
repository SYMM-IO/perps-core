// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IFundingRateEvents {
	event ChargeFundingRate(address partyB, address partyA, uint256[] quoteIds, int256[] rates);
	event SetLongFundingFee(uint256[] symbolIds, int256[] fees, int256[] marketPrices, address partyB);
	event SetShortFundingFee(uint256[] symbolIds, int256[] fees, int256[] marketPrices, address partyB);
	event SetEpochDuration(uint256[] symbolIds, uint256[] durations, address partyB);
	event UpdateAccumulatedFundingFee(uint256[] symbolIds, int256[] longRates, int256[] shortRates, int256[] marketPrices, address partyB);
	event AccumulatedFundingStateUpdated(
		uint256 indexed symbolId,
		address indexed partyB,
		int256 currentLongRate,
		int256 currentShortRate,
		int256 accumulatedLongRate,
		int256 accumulatedShortRate,
		uint256 lastUpdatedEpoch,
		uint256 lastUpdatedTimeStamp,
		uint256 startEpochTimeStamp,
		uint256 startEpoch,
		uint256 epochDuration,
		int256 snapshotLongFee,
		int256 snapshotShortFee
	);
	event ChargeAccumulatedFundingFee(address partyA, address partyB, uint256[] quoteIds, address sender);
}
