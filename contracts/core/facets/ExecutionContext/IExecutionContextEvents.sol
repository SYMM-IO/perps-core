// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Events emitted while configuring or using transient execution authority.
interface IExecutionContextEvents {
	/// @notice Emitted when a signer is installed or cleared.
	/// @dev Shared with the persistent setSigner path so existing indexers see one event
	///      regardless of which storage mechanism holds the signer.
	event SignerSet(address signer);
}
