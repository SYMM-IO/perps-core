// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IMasterAccountMigrationEvents {
	event BeginMasterAccountMigration(address partyB, uint256 migrationId);
	event MigrateMasterAccountQuotes(address partyB, uint256 partyAsProvided, uint256 partyAsProcessed);
	event FinalizeMasterAccountMigration(address partyB);
}
