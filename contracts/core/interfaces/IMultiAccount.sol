// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Interface for the MultiAccount contract that manages sub-accounts for users
interface IMultiAccount {
	/// @notice A sub-account with its on-chain address and human-readable name
	struct Account {
		address accountAddress;
		string name;
	}

	/// @notice Emitted when the account implementation bytecode is updated
	event SetAccountImplementation(bytes oldAddress, bytes newAddress);
	/// @notice Emitted when the Symmio core diamond address is updated
	event SetSymmioAddress(address oldAddress, address newAddress);
	/// @notice Emitted when a new sub-account contract is deployed
	event DeployContract(address sender, address contractAddress);
	/// @notice Emitted when a sub-account is added to a user
	event AddAccount(address user, address account, string name);
	/// @notice Emitted when a sub-account's name is changed
	event EditAccountName(address user, address account, string newName);
	/// @notice Emitted when collateral is deposited into a sub-account
	event DepositForAccount(address user, address account, uint256 amount);
	/// @notice Emitted when funds are allocated within a sub-account
	event AllocateForAccount(address user, address account, uint256 amount);
	/// @notice Emitted when funds are withdrawn from a sub-account
	event WithdrawFromAccount(address user, address account, uint256 amount);
	/// @notice Emitted when a delegated call is made on behalf of a sub-account
	event Call(address user, address account, bytes _callData, bool _success, bytes _resultData);
	/// @notice Emitted when access to a single function selector is delegated or revoked
	event DelegateAccess(address account, address target, bytes4 selector, bool state);
	/// @notice Emitted when access to multiple function selectors is delegated or revoked
	event DelegateAccesses(address account, address target, bytes4[] selector, bool state);
	/// @notice Emitted when a proposal to revoke access to function selectors is created
	event ProposeToRevokeAccesses(address account, address target, bytes4[] selector);
	/// @notice Emitted when the revoke cooldown period is updated
	event SetRevokeCooldown(uint256 oldCooldown, uint256 newCooldown);

	/// @notice Validates that a signature was produced by the owner of a sub-account
	/// @param account The sub-account address to verify ownership for
	/// @param hash The message hash that was signed
	/// @param signature The signature bytes to validate
	/// @return True if the signature is valid for the account's owner
	function isValidSignatureOfAccount(address account, bytes32 hash, bytes calldata signature) external view returns (bool);
}
