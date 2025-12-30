// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { IMasterAccountMigrationFacet } from "./IMasterAccountMigrationFacet.sol";
import { MasterAccountMigrationFacetImpl } from "./MasterAccountMigrationFacetImpl.sol";

contract MasterAccountMigrationFacet is Accessibility, IMasterAccountMigrationFacet {
	/**
	 * @notice Starts Party B migration to master account mode and pauses Party B actions.
	 * @param partyB The address of the Party B to migrate.
	 * @param initializeMasterBalances If true, zeroes out the master bucket before aggregation.
	 */
	function beginMasterAccountMigration(
		address partyB,
		bool initializeMasterBalances
	) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		require(GlobalAppStorage.layout().masterAccountEnabled, "MasterAccountMigration: Master account disabled");
		uint256 migrationId = MasterAccountMigrationFacetImpl.beginMasterAccountMigration(
			partyB,
			initializeMasterBalances
		);
		emit BeginMasterAccountMigration(partyB, migrationId);
	}

	/**
	 * @notice Aggregates Party B balances for master account migration based on provided PartyA list.
	 * @param partyB The address of the Party B to migrate.
	 * @param partyAs Party A addresses to aggregate.
	 */
	function migrateMasterAccountQuotes(
		address partyB,
		address[] calldata partyAs
	) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		uint256 partyAsProcessed = MasterAccountMigrationFacetImpl.migrateMasterAccountQuotes(partyB, partyAs);
		emit MigrateMasterAccountQuotes(partyB, partyAs.length, partyAsProcessed);
	}

	/**
	 * @notice Finalizes Party B migration to master account mode and unpauses Party B actions.
	 * @param partyB The address of the Party B to finalize migration for.
	 */
	function finalizeMasterAccountMigration(address partyB) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		MasterAccountMigrationFacetImpl.finalizeMasterAccountMigration(partyB);
		emit FinalizeMasterAccountMigration(partyB);
	}
}
