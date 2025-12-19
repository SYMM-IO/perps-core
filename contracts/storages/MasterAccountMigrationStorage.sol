// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

library MasterAccountMigrationStorage {
	bytes32 internal constant MASTER_ACCOUNT_MIGRATION_STORAGE_SLOT =
		keccak256("diamond.standard.storage.masteraccountmigration");

	struct Layout {
		mapping(address => bool) partyBMigrationPaused;
		mapping(address => uint256) partyBMigrationId;
		mapping(address => mapping(address => uint256)) partyBMigrationProcessedPartyA;
		mapping(address => bool) partyBMigrationComplete;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = MASTER_ACCOUNT_MIGRATION_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
