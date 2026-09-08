// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMigrationEvents } from "./IMigrationEvents.sol";
import { PositionType } from "../../storages/QuoteStorage.sol";

interface IMigrationFacet is IMigrationEvents {
	struct AggregateFundingGroup {
		address partyA;
		address partyB;
		uint256 symbolId;
		PositionType positionType;
	}

	/// @notice Backfill v0.8.5 quote-derived state for existing active positions
	/// @param quoteIds Array of quote IDs to migrate (batch)
	function migrateQuotes(uint256[] calldata quoteIds) external;

	/// @notice Migrate partyB balances to cross bucket
	/// @param partyB The partyB to migrate
	/// @param partyAs All partyA addresses that have positions with this partyB
	function migrateCrossLockedValues(address partyB, address[] calldata partyAs) external;

	/// @notice Rebuilds each funding group from its active quotes, atomically and in input order.
	/// @param groups PartyA/PartyB/symbol/side groups to repair. An empty batch is a no-op.
	function resyncAggregateFunding(AggregateFundingGroup[] calldata groups) external;

	/// @notice Check if a quote has been migrated
	/// @param quoteId The quote ID to check
	/// @return True if the quote has been migrated
	function isQuoteMigrated(uint256 quoteId) external view returns (bool);

	/// @notice Check if a partyB+partyA pair's locked values have been migrated to the cross bucket
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @return True if this pair has been migrated
	function isCrossLockedValuesMigrated(address partyB, address partyA) external view returns (bool);
}
