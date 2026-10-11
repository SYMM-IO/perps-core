// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Interface for SymmioPartyB contract that handles PartyB operations.
/// @dev PartyB contracts execute trading operations on behalf of market makers.
interface ISymmioPartyB {
	/// @notice Execute multiple operations as PartyB
	/// @param _callDatas Array of encoded function calls to execute
	function _call(bytes[] calldata _callDatas) external;
}
