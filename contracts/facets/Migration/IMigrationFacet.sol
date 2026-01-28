// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IMigrationEvents } from "./IMigrationEvents.sol";

interface IMigrationFacet is IMigrationEvents {
	/// @notice Migrate quotes to populate aggregated positions, funding, and active symbols
	/// @param quoteIds Array of quote IDs to migrate (batch)
	function migrateQuotes(uint256[] calldata quoteIds) external;

	/// @notice Migrate partyB balances to cross bucket
	/// @param partyB The partyB to migrate
	/// @param partyAs All partyA addresses that have positions with this partyB
	function migrateCrossLockedValues(address partyB, address[] calldata partyAs) external;

	/// @notice Check if a quote has been migrated
	/// @param quoteId The quote ID to check
	/// @return True if the quote has been migrated
	function isQuoteMigrated(uint256 quoteId) external view returns (bool);

	/// @notice Check if partyB locked values have been migrated
	/// @param partyB The partyB address to check
	/// @return True if the partyB locked values have been migrated
	function isPartyBLockedValuesMigrated(address partyB) external view returns (bool);
}
