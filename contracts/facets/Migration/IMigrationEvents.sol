// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IMigrationEvents {
	event QuotesMigrated(uint256 quotesProvided, uint256 quotesMigrated);
	event MasterAccountLockedValuesMigrated(address indexed partyB, uint256 partyAsProcessed);
}
