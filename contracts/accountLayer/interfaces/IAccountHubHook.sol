// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Hook interface that affiliates can implement to receive callbacks on account lifecycle events
interface IAccountHubHook {
	/// @notice Called when a new sub-account is created under the affiliate
	/// @param user The owner of the new sub-account
	/// @param subAccount The created sub-account address
	/// @param metadata Arbitrary metadata attached to the sub-account
	/// @return Whether the hook execution succeeded
	function onAccountCreation(address user, address subAccount, bytes memory metadata) external returns (bool);

	/// @notice Called when a new virtual account is created (or reused) under the affiliate
	/// @param virtualAccount The created or reused virtual account address
	/// @param parent The parent sub-account address
	/// @param metadata Arbitrary metadata attached to the virtual account
	/// @return Whether the hook execution succeeded
	function onVirtualAccountCreation(address virtualAccount, address parent, bytes memory metadata) external returns (bool);

	/// @notice Called when a virtual account is deleted after all its positions are closed
	/// @param account The deleted virtual account address
	function onVirtualAccountDeletion(address account) external;

	/// @notice Called when a sub-account is deleted
	/// @param subAccount The deleted sub-account address
	/// @param owner The owner of the deleted sub-account
	function onSubAccountDeletion(address subAccount, address owner) external;

	/// @notice Called after _call executes Symmio operations on behalf of an account
	/// @param account The account that calls were executed for
	/// @param callDatas The encoded function calls that were executed
	function onCall(address account, bytes[] memory callDatas) external;
}
