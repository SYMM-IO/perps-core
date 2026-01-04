// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

enum ADLReason {
	NOT_IN_CLOSE_STATE,
	PARTY_A_INSUFFICIENT_BALANCE,
	PARTY_B_INSUFFICIENT_BALANCE,
	INVALID_FILLED_AMOUNT
}
