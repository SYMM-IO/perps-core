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
///      - migrateQuotes(): Backfills aggregated positions/funding and other derived state for existing open positions
///      - migrateCrossLockedValues(): Sums per-PartyA balances into master bucket
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
		///      - quoteStorage.partyBPositionsCount[partyB][address(0)] total positions counter
		///      - accountStorage.connectedPartyBs / isConnectedPartyB connection cache
		///      Idempotent - skips already-migrated quotes.
		mapping(uint256 => bool) quoteMigrated;
		/// @notice Whether a specific PartyB+PartyA pair has been migrated to the cross bucket
		/// @dev Maps partyB => partyA => migrated. migrateCrossLockedValues() aggregates:
		///      - partyBAllocatedBalances[partyB][partyA] → partyBAllocatedBalances[partyB][address(0)]
		///      - partyBLockedBalances[partyB][partyA] → partyBLockedBalances[partyB][address(0)]
		///      - partyBPendingLockedBalances[partyB][partyA] → partyBPendingLockedBalances[partyB][address(0)]
		///      Can be called in batches - already-migrated pairs are skipped.
		///      Must be done before enabling master account mode for that PartyB.
		mapping(address => mapping(address => bool)) crossLockedValuesMigrated;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = MIGRATION_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
