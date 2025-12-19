// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/**
 * @title MockMultiAccount
 * @notice Mock implementation of MultiAccount for testing AccountHub legacy account support
 * @dev Implements only the functions that AccountHub needs to interact with
 */
contract MockMultiAccount {
    // ==================== State Variables ====================
    
    /// @notice Maps account addresses to their owner addresses
    mapping(address => address) public owners;
    
    /// @notice The Symmio core address this MultiAccount is connected to
    address public symmioAddress;
    
    /// @notice Counter for generating unique account addresses
    uint256 private accountCounter;
    
    // ==================== Events ====================
    
    event AccountCreated(address indexed owner, address indexed account);
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
    
    // ==================== Testing Helper Functions ====================
    
    /**
     * @notice Creates a mock account with a specific owner
     * @param owner The owner of the account
     * @return account The created account address
     * @dev Helper function for tests to set up legacy accounts
     */
    function createMockAccount(address owner) external returns (address account) {
        // Generate a deterministic but unique address
        account = address(uint160(uint256(keccak256(abi.encodePacked(
            "MockAccount",
            owner,
            accountCounter++,
            block.timestamp
        )))));
        
        owners[account] = owner;
        
        emit AccountCreated(owner, account);
        return account;
    }
    
    /**
     * @notice Sets the owner of an account
     * @param account The account address
     * @param owner The owner address
     * @dev Helper function for tests to manually configure ownership
     */
    function setOwner(address account, address owner) external {
        owners[account] = owner;
        emit OwnerSet(account, owner);
    }
    
    /**
     * @notice Sets the Symmio address
     * @param _symmioAddress The new Symmio address
     * @dev Helper function for tests to reconfigure the Symmio address
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
     * @notice Batch creates multiple mock accounts
     * @param owner The owner of all accounts
     * @param count The number of accounts to create
     * @return accounts Array of created account addresses
     * @dev Useful for setting up multiple test accounts quickly
     */
    function createMockAccounts(address owner, uint256 count) external returns (address[] memory accounts) {
        accounts = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            accounts[i] = address(uint160(uint256(keccak256(abi.encodePacked(
                "MockAccount",
                owner,
                accountCounter++,
                block.timestamp,
                i
            )))));
            owners[accounts[i]] = owner;
            emit AccountCreated(owner, accounts[i]);
        }
        return accounts;
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
}