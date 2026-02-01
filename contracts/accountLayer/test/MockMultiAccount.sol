// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import { IMultiAccount } from "../interfaces/IMultiAccount.sol";

/**
 * @title MockMultiAccount
 * @notice Mock implementation of MultiAccount for testing AccountHub legacy account support
 * @dev Implements the full IMultiAccount interface for comprehensive testing
 */
contract MockMultiAccount is IMultiAccount {
	// ==================== State Variables ====================

	/// @notice Maps user addresses to their array of accounts
	mapping(address => Account[]) private _accounts;

	/// @notice Maps account addresses to their owner addresses
	mapping(address => address) public owners;

	/// @notice Maps account addresses to their index in the owner's account array
	mapping(address => uint256) private _indexOfAccount;

	/// @notice The Symmio core address this MultiAccount is connected to
	address public symmioAddress;

	/// @notice Counter for generating unique account addresses
	uint256 private accountCounter;

	// ==================== Events ====================

	event AccountCreated(address indexed owner, address indexed account, string name);
	event OwnerSet(address indexed account, address indexed owner);
	event SymmioAddressSet(address indexed symmioAddress);

	// ==================== Constructor ====================

	/**
	 * @notice Initializes the mock MultiAccount
	 * @param _symmioAddress The Symmio core address
	 */
	constructor(address _symmioAddress) {
		symmioAddress = _symmioAddress;
	}

	// ==================== IMultiAccount Interface ====================

	/**
	 * @notice Returns the number of accounts belonging to a user
	 * @param user The user address
	 * @return The number of accounts
	 */
	function getAccountsLength(address user) external view override returns (uint256) {
		return _accounts[user].length;
	}

	/**
	 * @notice Returns paginated accounts for a user
	 * @param user The user address
	 * @param start The starting index
	 * @param size The maximum number of accounts to return
	 * @return userAccounts Array of Account structs
	 */
	function getAccounts(address user, uint256 start, uint256 size) external view override returns (Account[] memory userAccounts) {
		uint256 total = _accounts[user].length;
		if (start >= total) {
			return new Account[](0);
		}

		uint256 remaining = total - start;
		uint256 len = size > remaining ? remaining : size;
		userAccounts = new Account[](len);

		for (uint256 i = 0; i < len; i++) {
			userAccounts[i] = _accounts[user][start + i];
		}
	}

	// ==================== Testing Helper Functions ====================

	/**
	 * @notice Creates a mock account with a specific owner and name
	 * @param owner The owner of the account
	 * @param name The name for the account
	 * @return account The created account address
	 */
	function createMockAccountWithName(address owner, string memory name) external returns (address account) {
		account = address(
			uint160(uint256(keccak256(abi.encodePacked("MockAccount", owner, accountCounter++, block.timestamp))))
		);

		_indexOfAccount[account] = _accounts[owner].length;
		_accounts[owner].push(Account(account, name));
		owners[account] = owner;

		emit AccountCreated(owner, account, name);
	}

	/**
	 * @notice Creates a mock account with a default name
	 * @param owner The owner of the account
	 * @return account The created account address
	 */
	function createMockAccount(address owner) external returns (address account) {
		string memory defaultName = string(abi.encodePacked("Account_", _toString(accountCounter)));

		account = address(
			uint160(uint256(keccak256(abi.encodePacked("MockAccount", owner, accountCounter++, block.timestamp))))
		);

		_indexOfAccount[account] = _accounts[owner].length;
		_accounts[owner].push(Account(account, defaultName));
		owners[account] = owner;

		emit AccountCreated(owner, account, defaultName);
	}

	/**
	 * @notice Batch creates multiple mock accounts
	 * @param owner The owner of all accounts
	 * @param count The number of accounts to create
	 * @return accounts Array of created account addresses
	 */
	function createMockAccounts(address owner, uint256 count) external returns (address[] memory accounts) {
		accounts = new address[](count);
		for (uint256 i = 0; i < count; i++) {
			string memory name = string(abi.encodePacked("Account_", _toString(accountCounter)));

			accounts[i] = address(
				uint160(uint256(keccak256(abi.encodePacked("MockAccount", owner, accountCounter++, block.timestamp, i))))
			);

			_indexOfAccount[accounts[i]] = _accounts[owner].length;
			_accounts[owner].push(Account(accounts[i], name));
			owners[accounts[i]] = owner;

			emit AccountCreated(owner, accounts[i], name);
		}
	}

	/**
	 * @notice Sets the owner of an account (for testing edge cases)
	 * @param account The account address
	 * @param owner The owner address
	 */
	function setOwner(address account, address owner) external {
		owners[account] = owner;
		emit OwnerSet(account, owner);
	}

	/**
	 * @notice Sets the Symmio address
	 * @param _symmioAddress The new Symmio address
	 */
	function setSymmioAddress(address _symmioAddress) external {
		symmioAddress = _symmioAddress;
		emit SymmioAddressSet(_symmioAddress);
	}

	/**
	 * @notice Checks if an account exists (has an owner)
	 * @param account The account address
	 * @return Whether the account exists
	 */
	function accountExists(address account) external view returns (bool) {
		return owners[account] != address(0);
	}

	/**
	 * @notice Gets the owner of an account
	 * @param account The account address
	 * @return The owner address (address(0) if account doesn't exist)
	 */
	function getOwner(address account) external view returns (address) {
		return owners[account];
	}

	/**
	 * @notice Removes an account (sets owner to zero address)
	 * @param account The account to remove
	 * @dev Helper for testing account cleanup scenarios
	 */
	function removeAccount(address account) external {
		require(owners[account] != address(0), "MockMultiAccount: Account does not exist");
		delete owners[account];
		emit OwnerSet(account, address(0));
	}

	/**
	 * @notice Helper to convert uint to string
	 */
	function _toString(uint256 value) internal pure returns (string memory) {
		if (value == 0) return "0";

		uint256 temp = value;
		uint256 digits;
		while (temp != 0) {
			digits++;
			temp /= 10;
		}

		bytes memory buffer = new bytes(digits);
		while (value != 0) {
			digits--;
			buffer[digits] = bytes1(uint8(48 + (value % 10)));
			value /= 10;
		}

		return string(buffer);
	}
}
