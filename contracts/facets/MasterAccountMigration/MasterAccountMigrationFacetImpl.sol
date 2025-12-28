// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LockedValuesOps, LockedValues } from "../../libraries/LibLockedValues.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { MasterAccountMigrationStorage } from "../../storages/MasterAccountMigrationStorage.sol";

library MasterAccountMigrationFacetImpl {
	using LockedValuesOps for LockedValues;

	function beginMasterAccountMigration(address partyB, bool initializeMasterBalances) internal returns (uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MasterAccountMigrationStorage.Layout storage migrationLayout = MasterAccountMigrationStorage.layout();
		require(partyB != address(0), "MasterAccountMigration: Zero address");
		require(MAStorage.layout().partyBStatus[partyB], "MasterAccountMigration: Should be partyB");
		require(!accountLayout.masterAccountMode[partyB], "MasterAccountMigration: Master account mode is active");
		require(!migrationLayout.partyBMigrationComplete[partyB], "MasterAccountMigration: Migration already completed");
		require(!migrationLayout.partyBMigrationPaused[partyB], "MasterAccountMigration: Migration already in progress");

		migrationLayout.partyBMigrationPaused[partyB] = true;
		// Id is used to de-duplicate PartyA aggregation across quote batches in this migration run.
		// So that the migration gets done only once for each party A
		uint256 migrationId = ++migrationLayout.partyBMigrationId[partyB];
		if (initializeMasterBalances) {
			accountLayout.partyBAllocatedBalances[partyB][address(0)] = 0;
			accountLayout.partyBLockedBalances[partyB][address(0)].makeZero();
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].makeZero();
		}

		return migrationId;
	}

	function migrateMasterAccountQuotes(address partyB, address[] calldata partyAs) internal returns (uint256 partyAsProcessed) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MasterAccountMigrationStorage.Layout storage migrationLayout = MasterAccountMigrationStorage.layout();
		require(migrationLayout.partyBMigrationPaused[partyB], "MasterAccountMigration: Migration not active");

		uint256 migrationId = migrationLayout.partyBMigrationId[partyB];
		for (uint256 i = 0; i < partyAs.length; i++) {
			address partyA = partyAs[i];
			if (migrationLayout.partyBMigrationProcessedPartyA[partyB][partyA] == migrationId) {
				continue;
			}

			migrationLayout.partyBMigrationProcessedPartyA[partyB][partyA] = migrationId;
			partyAsProcessed++;
			accountLayout.partyBAllocatedBalances[partyB][address(0)] += accountLayout.partyBAllocatedBalances[partyB][partyA];
			accountLayout.partyBLockedBalances[partyB][address(0)].add(accountLayout.partyBLockedBalances[partyB][partyA]);
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].add(accountLayout.partyBPendingLockedBalances[partyB][partyA]);

			// resetting normal balances
			accountLayout.partyBAllocatedBalances[partyB][partyA] = 0;
		}
	}

	function finalizeMasterAccountMigration(address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MasterAccountMigrationStorage.Layout storage migrationLayout = MasterAccountMigrationStorage.layout();
		require(migrationLayout.partyBMigrationPaused[partyB], "MasterAccountMigration: Migration not active");

		accountLayout.masterAccountMode[partyB] = true;
		migrationLayout.partyBMigrationComplete[partyB] = true;
		migrationLayout.partyBMigrationPaused[partyB] = false;
	}
}
