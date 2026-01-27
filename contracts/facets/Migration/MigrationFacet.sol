// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { MigrationStorage } from "../../storages/MigrationStorage.sol";
import { IMigrationFacet } from "./IMigrationFacet.sol";
import { MigrationFacetImpl } from "./MigrationFacetImpl.sol";

contract MigrationFacet is Accessibility, IMigrationFacet {
	/**
	 * @notice Begin migration for a partyB by pausing their actions
	 * @dev This must be called before migrating quotes and locked values
	 * @param partyB The partyB to begin migration for
	 */
	function beginMigration(address partyB) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		MigrationFacetImpl.beginMigration(partyB);
		emit MigrationBegun(partyB);
	}

	/**
	 * @notice Finalize migration for a partyB
	 * @dev This optionally enables master account mode and unpauses the partyB
	 * @param partyB The partyB to finalize migration for
	 * @param enableMasterMode Whether to enable master account mode
	 */
	function finalizeMigration(address partyB, bool enableMasterMode) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		MigrationFacetImpl.finalizeMigration(partyB, enableMasterMode);
		emit MigrationFinalized(partyB, enableMasterMode);
	}

	/**
	 * @notice Migrate quotes to populate aggregated positions, funding, and active symbols
	 * @dev Can be called multiple times with different batches. Already migrated quotes are skipped.
	 * @param quoteIds Array of quote IDs to migrate
	 */
	function migrateQuotes(uint256[] calldata quoteIds) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		uint256 quotesMigrated = MigrationFacetImpl.migrateQuotes(quoteIds);
		emit QuotesMigrated(quoteIds.length, quotesMigrated);
	}

	/**
	 * @notice Migrate partyB locked values to master bucket for master account mode (v8.4 data)
	 * @dev IMPORTANT: Only use this for partyBs with pre-v8.5 data.
	 *      For partyBs with only v8.5 data, use migrateAllocatedBalances instead.
	 * @param partyB The partyB to migrate
	 * @param partyAs All partyA addresses that have positions with this partyB
	 */
	function migrateMasterAccountLockedValues(
		address partyB,
		address[] calldata partyAs
	) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		uint256 partyAsProcessed = MigrationFacetImpl.migrateMasterAccountLockedValues(partyB, partyAs);
		emit MasterAccountLockedValuesMigrated(partyB, partyAsProcessed);
	}

	/**
	 * @notice Migrate only allocated balances to master bucket (for v8.5 data)
	 * @dev Use this for partyBs whose positions were created after v8.5, where locked values are already in master bucket.
	 * @param partyB The partyB to migrate
	 * @param partyAs All partyA addresses that have balances with this partyB
	 */
	function migrateAllocatedBalances(
		address partyB,
		address[] calldata partyAs
	) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		uint256 partyAsProcessed = MigrationFacetImpl.migrateAllocatedBalances(partyB, partyAs);
		emit MasterAccountLockedValuesMigrated(partyB, partyAsProcessed);
	}

	/**
	 * @notice Check if a quote has been migrated
	 * @param quoteId The quote ID to check
	 * @return True if the quote has been migrated
	 */
	function isQuoteMigrated(uint256 quoteId) external view returns (bool) {
		return MigrationStorage.layout().quoteMigrated[quoteId];
	}

	/**
	 * @notice Check if partyB locked values have been migrated
	 * @param partyB The partyB address to check
	 * @return True if the partyB locked values have been migrated
	 */
	function isPartyBLockedValuesMigrated(address partyB) external view returns (bool) {
		return MigrationStorage.layout().partyBLockedValuesMigrated[partyB];
	}

	/**
	 * @notice Check if partyB migration is in progress (paused)
	 * @param partyB The partyB address to check
	 * @return True if the partyB is currently paused for migration
	 */
	function isPartyBMigrationInProgress(address partyB) external view returns (bool) {
		return MigrationStorage.layout().partyBMigrationPaused[partyB];
	}
}
