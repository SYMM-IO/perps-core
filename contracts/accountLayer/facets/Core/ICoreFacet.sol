// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SubAccountCreationData, VirtualAccountIsolationType, LegacyAccountImportData } from "../../storages/AccountStorage.sol";
import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

/// @notice Events emitted by the CoreFacet
interface ICoreFacetEvents {
	/// @notice Emitted when a new sub-account is created
	event SubAccountCreated(address indexed account, address indexed owner, address indexed affiliate, string name);
	/// @notice Emitted when a sub-account is deleted
	event SubAccountDeleted(address indexed account, address indexed owner, address indexed affiliate);
	/// @notice Emitted when a new virtual account is created
	event VirtualAccountCreated(address indexed account, address indexed parent);
	/// @notice Emitted when a previously deleted virtual account is reused
	event VirtualAccountReused(address indexed account, address indexed parent);
	/// @notice Emitted when a virtual account is deleted (all positions closed)
	event VirtualAccountDeleted(address indexed account, address indexed parent);
	/// @notice Emitted when single VA mode is toggled on a sub-account
	event SingleVAModeChanged(address indexed subAccount, bool enabled);
	/// @notice Emitted when a sub-account name is changed
	event EditAccountName(address indexed account, string name);
	/// @notice Emitted for each call executed on the Symmio core on behalf of an account
	event Call(address indexed sender, address indexed account, bytes callData, bool success, bytes resultData);
	/// @notice Emitted when a hook executes a Symmio call on behalf of an account
	event HookActionExecuted(address indexed account, address indexed affiliate, bytes4 selector);
	/// @notice Emitted when a legacy MultiAccount is imported into the AccountLayer
	event LegacyAccountImported(address indexed account, address indexed owner, address indexed legacyContract, address affiliate);
}

/// @notice Interface for sub-account/virtual account management, deposits, and call execution
interface ICoreFacet is ICoreFacetEvents, IAccountLayerErrors {
	// ==================== Sub-Account Management ====================

	/// @notice Creates one or more sub-accounts under the specified affiliate
	/// @param affiliate The affiliate address
	/// @param accountsData Configuration for each sub-account to create
	/// @return The deterministic addresses of the created sub-accounts
	function createSubAccounts(address affiliate, SubAccountCreationData[] memory accountsData) external returns (address[] memory);

	/// @notice Updates the display name of a sub-account
	/// @param account The sub-account address
	/// @param name The new name
	function editAccountName(address account, string memory name) external;

	/// @notice Toggles single virtual account mode for a sub-account
	/// @param subAccount The sub-account address
	/// @param enabled Whether single VA mode should be enabled
	function setSingleVAMode(address subAccount, bool enabled) external;

	/// @notice Deletes a sub-account that has no active VAs, positions, or balance
	/// @param subAccount The sub-account address to delete
	function deleteSubAccount(address subAccount) external;

	// ==================== Virtual Account Management ====================

	/// @notice Manually creates a virtual account under a CUSTOM isolation sub-account
	/// @param parentAccount The parent sub-account
	/// @param metadata Arbitrary metadata for the virtual account
	/// @param isolationType The isolation type for the virtual account
	/// @param symbolId The symbol the virtual account is restricted to
	/// @return The address of the created or reused virtual account
	function createCustomVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external returns (address);

	// ==================== Deposit Functions ====================

	/// @notice Deposits collateral into the Symmio core for the specified account
	/// @param account The account to deposit for
	/// @param amount The amount of collateral to deposit
	function depositForAccount(address account, uint256 amount) external;

	/// @notice Deposits and immediately allocates collateral for the specified account
	/// @param account The account to deposit and allocate for
	/// @param amount The amount of collateral to deposit and allocate
	function depositAndAllocateForAccount(address account, uint256 amount) external;

	/// @notice Deposits collateral with express rate split between Symmio and a virtual provider
	/// @param account The account to deposit for
	/// @param amount The total amount of collateral to deposit
	function depositForAccountWithExpressRate(address account, uint256 amount) external;

	/// @notice Deposits and allocates collateral with express rate split
	/// @param account The account to deposit and allocate for
	/// @param amount The total amount of collateral
	function depositAndAllocateForAccountWithExpressRate(address account, uint256 amount) external;

	// ==================== Call Execution ====================

	/// @notice Executes an array of Symmio core calls on behalf of an account
	/// @param account The account to execute calls for
	/// @param callDatas Array of encoded function calls
	/// @return Array of return data from each call
	function _call(address account, bytes[] calldata callDatas) external returns (bytes[] memory);

	// ==================== Hook Callback ====================

	/// @notice Executes a whitelisted Symmio call during an active hook context
	/// @param callData The encoded function call to execute
	function executeForAccount(bytes calldata callData) external;

	// ==================== Legacy Account Migration ====================

	/// @notice Imports accounts from a legacy MultiAccount contract
	/// @param legacyContract The legacy MultiAccount contract address
	/// @param affiliate The affiliate to associate imported accounts with
	/// @param symmioCores The Symmio core addresses for the affiliate
	/// @param accountsData Import data for each account
	/// @return importedAccounts The imported sub-account addresses
	function importLegacyAccounts(
		address legacyContract,
		address affiliate,
		address[] calldata symmioCores,
		LegacyAccountImportData[] calldata accountsData
	) external returns (address[] memory importedAccounts);
}
