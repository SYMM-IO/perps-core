// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title MigrationStorage
/// @notice Tracks migration progress when upgrading from v0.8.4 to v0.8.5
/// @dev V0.8.5 introduces two major features requiring data migration:
///      1. Master Account Mode - Unified PartyB balance management via address(0) bucket
///      2. Aggregated Positions - O(symbols) UPNL/funding calculations instead of O(quotes)
///
///      Migration is performed via MigrationFacet with MIGRATION_ROLE:
///      - migrateQuotes(): Populates aggregated positions and funding from existing quotes
///      - migrateMasterAccountLockedValues(): Sums per-PartyA balances into master bucket
library MigrationStorage {
	bytes32 internal constant MIGRATION_STORAGE_SLOT = keccak256("diamond.standard.storage.migration");

	struct Layout {
		/// @notice Whether each quote has been processed for aggregated position migration
		/// @dev Maps quoteId => migrated. migrateQuotes() processes OPENED, CLOSE_PENDING,
		///      and CANCEL_CLOSE_PENDING quotes to populate:
		///      - partyBAggregatedPositions / partyAAggregatedPositionsPerPartyB
		///      - partyBAggregatedFunding / partyAAggregatedFundingPerPartyB
		///      - activeSymbols arrays
		///      - quote.accumulatedPaidFunding (initialized from current funding rates)
		///      Idempotent - skips already-migrated quotes.
		mapping(uint256 => bool) quoteMigrated;
		/// @notice Whether PartyB's per-PartyA balances have been summed into master bucket
		/// @dev Maps partyB => migrated. migrateMasterAccountLockedValues() aggregates:
		///      - partyBAllocatedBalances[partyB][partyA] → partyBAllocatedBalances[partyB][address(0)]
		///      - partyBLockedBalances[partyB][partyA] → partyBLockedBalances[partyB][address(0)]
		///      - partyBPendingLockedBalances[partyB][partyA] → partyBPendingLockedBalances[partyB][address(0)]
		///      Must be done before enabling master account mode for that PartyB.
		mapping(address => bool) partyBLockedValuesMigrated;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = MIGRATION_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
