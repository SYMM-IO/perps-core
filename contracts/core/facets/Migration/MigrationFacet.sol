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
	/// @notice Backfill quote-derived state for v0.8.4 -> v0.8.5 upgrade
	/// @dev Can be called multiple times with different batches. Already migrated quotes are skipped.
	///      Backfills aggregated positions/funding, accumulatedPaidFunding baseline, PartyB total positions counter, and PartyA<>PartyB connection cache.
	/// @param quoteIds Array of quote IDs to migrate
	function migrateQuotes(uint256[] calldata quoteIds) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		uint256 quotesMigrated = MigrationFacetImpl.migrateQuotes(quoteIds);
		emit QuotesMigrated(quoteIds.length, quotesMigrated);
	}

	/// @notice Migrate partyB balances to cross bucket for cross partyB mode
	/// @dev Should be called during the v0.8.4 -> v0.8.5 upgrade while the system is paused.
	/// @param partyB The partyB to migrate
	/// @param partyAs All partyA addresses that have positions with this partyB
	function migrateCrossLockedValues(address partyB, address[] calldata partyAs) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		uint256 partyAsProcessed = MigrationFacetImpl.migrateCrossLockedValues(partyB, partyAs);
		emit CrossLockedValuesMigrated(partyB, partyAsProcessed);
	}

	/// @notice Check if a quote has been migrated
	/// @param quoteId The quote ID to check
	/// @return True if the quote has been migrated
	function isQuoteMigrated(uint256 quoteId) external view returns (bool) {
		return MigrationStorage.layout().quoteMigrated[quoteId];
	}

	/// @notice Check if a partyB+partyA pair's locked values have been migrated to the cross bucket
	/// @param partyB The partyB address
	/// @param partyA The partyA address
	/// @return True if this pair has been migrated
	function isCrossLockedValuesMigrated(address partyB, address partyA) external view returns (bool) {
		return MigrationStorage.layout().crossLockedValuesMigrated[partyB][partyA];
	}
}
