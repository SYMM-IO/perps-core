// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PositionType } from "../../storages/QuoteStorage.sol";

interface IMigrationEvents {
	event QuotesMigrated(uint256 quotesProvided, uint256 quotesMigrated);
	event CrossLockedValuesMigrated(address indexed partyB, uint256 partyAsProcessed);
	event AggregateFundingResynced(
		address indexed partyA,
		address indexed partyB,
		uint256 indexed symbolId,
		PositionType positionType,
		int256 oldPartyAFunding,
		int256 oldPartyBFunding,
		int256 newFunding,
		int256 oldGlobalFunding,
		int256 newGlobalFunding
	);
}
