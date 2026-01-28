// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

library MigrationStorage {
	bytes32 internal constant MIGRATION_STORAGE_SLOT = keccak256("diamond.standard.storage.migration");

	struct Layout {
		// Track processed quotes to avoid double-counting
		mapping(uint256 => bool) quoteMigrated;
		// Track partyBs that have had locked values migrated to cross bucket
		mapping(address => bool) partyBLockedValuesMigrated;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = MIGRATION_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
