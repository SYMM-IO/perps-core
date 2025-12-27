// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./interfaces/IAccountHub.sol";
import "./interfaces/IAccountHubInternal.sol";
import "./interfaces/IAffiliateHub.sol";
import "./interfaces/ISymmio.sol";
import "./interfaces/IAccountHubHook.sol";
import "./interfaces/IMultiAccount.sol";
import "./libraries/LibQuoteParams.sol";

/**
 * @title AccountHub
 * @notice Manages sub-accounts and virtual accounts for the Symmio protocol
 * @dev Implements role-based access control, pausability, and reentrancy protection
 */
contract AccountHub is IAccountHub, IAccountHubInternal, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	// ==================== Constants ====================
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant SIGNER_SETTER_ROLE = keccak256("SIGNER_SETTER_ROLE");
	bytes32 public constant INSTANT_LAYER_ROLE = keccak256("INSTANT_LAYER_ROLE");
	bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	uint256 public constant MAX_NAME_LENGTH = 100;

	// ==================== State Variables ====================

	mapping(address => SubAccountData) private subAccounts;
	mapping(address => VirtualAccountData) private virtualAccounts;
	mapping(address => EnumerableSet.AddressSet) private userToSubAccounts;
	mapping(address => EnumerableSet.AddressSet) private subAccountToVirtualAccounts;

	// Pool of deleted virtual accounts for reuse: parentAccount => isolationType => symbolId => stack of addresses
	mapping(address => mapping(VirtualAccountIsolationType => mapping(uint256 => address[]))) private deletedVirtualAccountsPool;

	// Active virtual account by key (for singleVAMode): subAccount => isolationType => symbolId => VA address
	mapping(address => mapping(VirtualAccountIsolationType => mapping(uint256 => address))) private activeVAByKey;

	address public affiliateHub;
	address public accountHubLens;
	address internal globalSigner;
	uint256 public globalNonce;

	// Per-subAccount nonce for virtual account creation
	mapping(address => uint256) private subAccountVirtualNonces;

	// AccountManager deployment
	bytes public accountManagerImplementation;
	bytes32 internal initAccountManagerCodeHash;

	// ==================== Modifiers ====================

	/**
	 * @dev Ensures the caller is a registered Symmio core
	 */
	modifier onlySymmio() {
		if (!IAffiliateHub(affiliateHub).isWhitelistedSymmioCore(msg.sender)) revert NotSymmioCore();
		_;
	}

	/**
	 * @dev Ensures the caller is the owner of the account
	 */
	modifier onlyAccountOwner(address account) {
		if (!_isOwnerOf(account, msg.sender)) revert NotOwner();
		_;
	}

	// ==================== Constructor & Initializer ====================

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initializes the AccountHub contract
	 * @param _admin The default admin address
	 * @param _affiliateHub The AffiliateHub contract address
	 * @param _accountManagerImplementation The bytecode for account manager deployment
	 */
	function initialize(address _admin, address _affiliateHub, bytes memory _accountManagerImplementation) public initializer {
		if (_admin == address(0)) revert ZeroAddress();
		if (_affiliateHub == address(0)) revert ZeroAddress();
		if (_accountManagerImplementation.length == 0) revert EmptyArray();

		__Pausable_init();
		__AccessControl_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);

		affiliateHub = _affiliateHub;
		accountManagerImplementation = _accountManagerImplementation;
		initAccountManagerCodeHash = keccak256(abi.encodePacked(_accountManagerImplementation));
	}

	// ==================== Account Management ====================

	/**
	 * @notice Creates multiple sub-accounts in a single transaction
	 * @param affiliate The affiliate address
	 * @param accountsData Array of account creation data
	 * @return Array of created account addresses
	 */
	function createSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		if (accountsData.length == 0) revert EmptyArray();

		address[] memory createdAccounts = new address[](accountsData.length);
		address signer = getSigner();

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = _createSubAccount(affiliate, signer, accountsData[i]);
		}

		return createdAccounts;
	}

	/**
	 * @notice Manually creates or reuses a virtual account for a sub-account
	 * @param parentAccount The parent sub-account address
	 * @param metadata The metadata for the virtual account
	 * @param isolationType The isolation type for the virtual account
	 * @param symbolId The symbol ID (required for MARKET isolation types)
	 * @return virtualAccount The created or reused virtual account address
	 */
	function createCustomVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external whenNotPaused nonReentrant onlyAccountOwner(parentAccount) returns (address) {
		SubAccountData storage parent = subAccounts[parentAccount];

		if (parent.isolationType != SubAccountIsolationType.CUSTOM) {
			revert OnlyCustomIsolationCanCreateManually();
		}

		return _getOrCreateVirtualAccount(parentAccount, metadata, isolationType, symbolId);
	}

	/**
	 * @notice Edits the name of an existing account
	 * @param account The account address
	 * @param name The new name
	 */
	function editAccountName(address account, string memory name) external whenNotPaused onlyAccountOwner(account) {
		_validateName(name);

		if (!subAccounts[account].isExists) revert AccountDoesNotExist();

		subAccounts[account].name = name;
		emit EditAccountName(account, name);
	}

	/**
	 * @notice Sets or unsets the single VA mode for a sub-account
	 * @dev Can only be changed when the sub-account has no active virtual accounts
	 * @dev Only applicable for MARKET and MARKET_DIRECTION isolation types
	 * @param subAccount The sub-account address
	 * @param enabled Whether to enable or disable single VA mode
	 */
	function setSingleVAMode(address subAccount, bool enabled) external whenNotPaused onlyAccountOwner(subAccount) {
		SubAccountData storage s = subAccounts[subAccount];
		if (!s.isExists) revert AccountDoesNotExist();

		// singleVAMode is only applicable for MARKET and MARKET_DIRECTION isolation types
		if (enabled && s.isolationType != SubAccountIsolationType.MARKET && s.isolationType != SubAccountIsolationType.MARKET_DIRECTION) {
			revert SingleVAModeNotApplicable();
		}

		// Can only change mode when there are no active virtual accounts
		if (subAccountToVirtualAccounts[subAccount].length() > 0) {
			revert HasActiveVirtualAccounts();
		}

		s.singleVAMode = enabled;
		emit SingleVAModeChanged(subAccount, enabled);
	}

	/**
	 * @notice Executes arbitrary calls on behalf of an account
	 * @param account The account address
	 * @param callDatas Array of encoded function calls
	 */
	function _call(address account, bytes[] calldata callDatas) external whenNotPaused nonReentrant returns (bytes[] memory) {
		if (callDatas.length == 0) revert EmptyArray();

		address signer = getSigner();
		if (!_isOwnerOf(account, signer) && !hasRole(INSTANT_LAYER_ROLE, msg.sender)) {
			revert NotOwner();
		}

		bytes[] memory results = new bytes[](callDatas.length);

		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata cd = callDatas[i];
			bytes4 selector = bytes4(cd[:4]);

			if (
				selector == LibQuoteParams.SEND_QUOTE_SELECTOR ||
				selector == LibQuoteParams.SEND_QUOTE_WITH_AFFILIATE_SELECTOR ||
				selector == LibQuoteParams.SEND_QUOTE_WITH_AFFILIATE_AND_DATA_SELECTOR
			) {
				QuoteParams memory p = LibQuoteParams.decodeQuoteParams(cd);

				if (virtualAccounts[account].isExists) {
					results[i] = _handleVirtualAccountSendQuote(account, cd, p);
					return results;
				}

				if (subAccounts[account].isExists) {
					results[i] = _handleSubAccountSendQuote(account, cd, p);
					return results;
				}
			}

			results[i] = _executeWithSigner(account, cd);
		}

		return results;
	}

	/**
	 * @notice Transfers balance from a sub-account to a virtual account
	 * @param virtualAccount The virtual account address (destination)
	 * @param amount The amount to transfer in 18 decimals
	 */
	function addMargin(address virtualAccount, uint256 amount) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();
		if (!virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = virtualAccounts[virtualAccount].parentAccount;

		_executeWithSigner(parent, abi.encodeWithSelector(ISymmio.internalTransfer.selector, virtualAccount, amount));

		emit AddMargin(virtualAccount, parent, amount);
	}

	/**
	 * @notice Transfers balance from a sub-account to a predicted virtual account address
	 * @dev Use this to pre-fund a virtual account before it's created by sendQuote
	 * @param subAccount The sub-account address (source of funds)
	 * @param isolationType The isolation type of the virtual account to be created
	 * @param symbolId The symbol ID for the virtual account
	 * @param amount The amount to transfer in 18 decimals
	 */
	function addMarginToNextVA(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId,
		uint256 amount
	) external whenNotPaused nonReentrant onlyAccountOwner(subAccount) {
		if (amount == 0) revert ZeroAmount();
		if (!subAccounts[subAccount].isExists) revert AccountDoesNotExist();

		// Predict the next VA address
		address predictedVA = _predictNextVirtualAccountAddress(subAccount, isolationType, symbolId);

		// Transfer from sub-account to predicted VA
		_executeWithSigner(subAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, predictedVA, amount));

		emit AddMargin(predictedVA, subAccount, amount);
	}

	/**
	 * @notice Transfers balance from a virtual account to a sub-account
	 * @param virtualAccount The virtual account address (source)
	 * @param amount The amount to transfer in 18 decimals
	 */
	function removeMargin(
		address virtualAccount,
		uint256 amount,
		ISymmio.SingleUpnlSig memory upnlSig
	) external whenNotPaused nonReentrant onlyAccountOwner(virtualAccount) {
		if (amount == 0) revert ZeroAmount();
		if (!virtualAccounts[virtualAccount].isExists) revert NotVirtualAccount();
		address parent = virtualAccounts[virtualAccount].parentAccount;

		_executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.deallocate.selector, amount, upnlSig));
		_executeWithSigner(virtualAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parent, amount));

		emit RemoveMargin(virtualAccount, parent, amount);
	}

	// ==================== Symmio Callback ====================

	/**
	 * @notice Callback from Symmio when a position is closed
	 * @param quoteId The quote ID
	 * @param partyA The party A address
	 */
	function onClosePosition(
		uint256 quoteId,
		uint256 /* _filledAmount */,
		uint256 /* _closedPrice */,
		address partyA,
		address /* _partyB */
	) external onlySymmio nonReentrant whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA);
	}

	function onCancelQuote(uint256 quoteId, address partyA, address /* partyB */) external onlySymmio whenNotPaused {
		_removeQuoteFromAccount(quoteId, partyA);
	}

	/**
	 * @notice Internal function to remove a quote from virtual or sub account
	 * @param quoteId The quote ID to remove
	 * @param partyA The party A address
	 */
	function _removeQuoteFromAccount(uint256 quoteId, address partyA) private {
		VirtualAccountData storage vData = virtualAccounts[partyA];

		if (vData.isExists) {
			vData.quoteIds.remove(quoteId);
			if (vData.quoteIds.length() == 0) {
				_deleteVirtualAccount(partyA);
			}
		}
	}

	// ==================== Admin Functions ====================

	/**
	 * @notice Deploys an AccountManager for an affiliate
	 * @dev Only callable by addresses with DEPLOYER_ROLE (typically AffiliateHub)
	 * @param affiliate The affiliate address (used as the AccountManager address via CREATE2)
	 * @param registrant The original registrant who requested the affiliate
	 * @param name The affiliate name used for deterministic address generation
	 * @return accountManager The deployed AccountManager address
	 */
	function deployAccountManager(
		address affiliate,
		address registrant,
		string memory name
	) external onlyRole(DEPLOYER_ROLE) whenNotPaused returns (address accountManager) {
		accountManager = _deployAccountManager(registrant, name);
		if (affiliate != accountManager) revert DeploymentFailed();

		_grantRole(SIGNER_SETTER_ROLE, accountManager);

		emit AccountManagerDeployed(affiliate, accountManager);
	}

	/**
	 * @notice Sets the AffiliateHub contract address (only for emergency updates)
	 * @param _affiliateHub The new AffiliateHub address
	 */
	function setAffiliateHub(address _affiliateHub) external onlyRole(SETTER_ROLE) {
		if (_affiliateHub == address(0)) revert ZeroAddress();
		affiliateHub = _affiliateHub;
	}

	/**
	 * @notice Sets the AccountHubLens contract address
	 * @param _accountHubLens The new AccountHubLens address
	 */
	function setAccountHubLens(address _accountHubLens) external onlyRole(SETTER_ROLE) {
		if (_accountHubLens == address(0)) revert ZeroAddress();
		accountHubLens = _accountHubLens;
	}

	/**
	 * @notice Updates the account manager implementation bytecode
	 * @param implementation The new implementation bytecode
	 */
	function setAccountManagerImplementation(bytes memory implementation) external onlyRole(SETTER_ROLE) {
		if (implementation.length == 0) revert EmptyArray();
		accountManagerImplementation = implementation;
		initAccountManagerCodeHash = keccak256(abi.encodePacked(accountManagerImplementation));
	}

	/**
	 * @notice Sets the global signer address
	 * @param _signer The new signer address
	 */
	function setSigner(address _signer) external onlyRole(SIGNER_SETTER_ROLE) {
		globalSigner = _signer;
	}

	/**
	 * @notice Pauses the contract
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpauses the contract
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	// ==================== View Functions ====================

	/**
	 * @notice Gets the current signer (global or msg.sender)
	 * @return The signer address
	 */
	function getSigner() public view returns (address) {
		return globalSigner == address(0) ? msg.sender : globalSigner;
	}

	/**
	 * @notice Gets the related Symmio core for an account
	 * @param account The account address
	 * @return The core address
	 */
	function getRelatedCore(address account) public view returns (address) {
		if (subAccounts[account].isExists) {
			return subAccounts[account].symmioCore;
		}

		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return getRelatedCore(parent);
		}

		return _getLegacyCore(account);
	}

	/**
	 * @notice Resolves the owner of a sub account & virtual account & legacy account
	 * @param account The account address to resolve
	 * @return The resolved owner address
	 */
	function ownerOf(address account) external view returns (address) {
		return _resolveAccountOwner(account);
	}

	// ==================== Raw Storage Accessors (for AccountHubLens) ====================

	function getSubAccountRaw(address account) external view returns (SubAccountDetail memory) {
		SubAccountData storage s = subAccounts[account];
		return
			SubAccountDetail({
				accountAddress: account,
				owner: s.owner,
				name: s.name,
				isExists: s.isExists,
				singleVAMode: s.singleVAMode,
				affiliate: s.affiliate,
				symmioCore: s.symmioCore,
				metadata: s.metadata,
				isolationType: s.isolationType
			});
	}

	function getVirtualAccountRaw(address account) external view returns (VirtualAccountDetail memory) {
		VirtualAccountData storage v = virtualAccounts[account];
		return
			VirtualAccountDetail({
				accountAddress: account,
				parentAccount: v.parentAccount,
				symbolId: v.symbolId,
				metadata: v.metadata,
				isExists: v.isExists,
				isolationType: v.isolationType
			});
	}

	function getUserSubAccountsCount(address owner) external view returns (uint256) {
		return userToSubAccounts[owner].length();
	}

	function getUserSubAccountAt(address owner, uint256 index) external view returns (address) {
		return userToSubAccounts[owner].at(index);
	}

	function getSubAccountVirtualAccountsCount(address subAccount) external view returns (uint256) {
		return subAccountToVirtualAccounts[subAccount].length();
	}

	function getSubAccountVirtualAccountAt(address subAccount, uint256 index) external view returns (address) {
		return subAccountToVirtualAccounts[subAccount].at(index);
	}

	function getVirtualAccountQuoteIdsCount(address account) external view returns (uint256) {
		return virtualAccounts[account].quoteIds.length();
	}

	function getVirtualAccountQuoteIdAt(address account, uint256 index) external view returns (uint256) {
		return virtualAccounts[account].quoteIds.at(index);
	}

	function getActiveVAByKeyRaw(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address) {
		return activeVAByKey[subAccount][isolationType][symbolId];
	}

	function getSubAccountVirtualNonceRaw(address subAccount) external view returns (uint256) {
		return subAccountVirtualNonces[subAccount];
	}

	function getDeletedVirtualAccountsPoolLength(
		address parentAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (uint256) {
		return deletedVirtualAccountsPool[parentAccount][isolationType][symbolId].length;
	}

	function getDeletedVirtualAccountAt(
		address parentAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId,
		uint256 index
	) external view returns (address) {
		return deletedVirtualAccountsPool[parentAccount][isolationType][symbolId][index];
	}

	// ==================== Internal Functions ====================

	/**
	 * @dev Validates name length
	 */
	function _validateName(string memory name) private pure {
		if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LENGTH) {
			revert InvalidNameLength();
		}
	}

	/**
	 * @dev Creates a single sub-account
	 */
	function _createSubAccount(address affiliate, address sender, SubAccountCreationData memory data) private returns (address subAccountAddress) {
		_validateName(data.name);
		if (!IAffiliateHub(affiliateHub).isWhitelistedSymmioCore(data.symmioCore)) revert NotSymmioCore();
		if (IAffiliateHub(affiliateHub).getAffiliateState(affiliate) != IAffiliateHub.AffiliateState.ACTIVE) revert AffiliateNotActive();

		// singleVAMode is only applicable for MARKET and MARKET_DIRECTION isolation types
		if (
			data.singleVAMode &&
			data.isolationType != SubAccountIsolationType.MARKET &&
			data.isolationType != SubAccountIsolationType.MARKET_DIRECTION
		) {
			revert SingleVAModeNotApplicable();
		}

		uint256 nonce = ++globalNonce;
		subAccountAddress = _generateSubAccountAddress(affiliate, sender, nonce);

		SubAccountData storage s = subAccounts[subAccountAddress];
		s.owner = sender;
		s.isExists = true;
		s.singleVAMode = data.singleVAMode;
		s.name = data.name;
		s.affiliate = affiliate;
		s.metadata = data.metadata;
		s.symmioCore = data.symmioCore;
		s.isolationType = data.isolationType;

		userToSubAccounts[sender].add(subAccountAddress);

		_callHook(
			affiliate,
			IAccountHubHook.onAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onAccountCreation.selector, sender, subAccountAddress, data.metadata)
		);

		emit SubAccountCreated(subAccountAddress, sender, affiliate, data.name);
	}

	/**
	 * @dev Gets or creates a virtual account, trying to reuse a deleted one first
	 * @dev If singleVAMode is enabled and an active VA exists for the key, returns that VA
	 */
	function _getOrCreateVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private returns (address) {
		// If singleVAMode is enabled, check if there's already an active VA for this key
		if (subAccounts[parentAccount].singleVAMode) {
			address existingVA = activeVAByKey[parentAccount][isolationType][symbolId];
			if (existingVA != address(0) && virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		address reused = _tryReuseVirtualAccount(parentAccount, isolationType, symbolId);
		if (reused != address(0)) return reused;
		return _createVirtualAccount(parentAccount, metadata, isolationType, symbolId);
	}

	/**
	 * @dev Tries to reuse a deleted virtual account from the pool
	 * @return The reused account address, or address(0) if none available
	 */
	function _tryReuseVirtualAccount(address parentAccount, VirtualAccountIsolationType isolationType, uint256 symbolId) private returns (address) {
		address[] storage pool = deletedVirtualAccountsPool[parentAccount][isolationType][symbolId];
		if (pool.length == 0) return address(0);

		// Pop from the stack (LIFO)
		address reusedAccount = pool[pool.length - 1];
		pool.pop();

		// Reactivate the virtual account
		VirtualAccountData storage v = virtualAccounts[reusedAccount];
		v.isExists = true;

		// Add back to active set
		subAccountToVirtualAccounts[parentAccount].add(reusedAccount);

		SubAccountData storage parent = subAccounts[parentAccount];

		// If singleVAMode is enabled, track this as the active VA for this key
		if (parent.singleVAMode) {
			activeVAByKey[parentAccount][isolationType][symbolId] = reusedAccount;
		}

		_callHook(
			parent.affiliate,
			IAccountHubHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountCreation.selector, reusedAccount, parentAccount, v.metadata)
		);

		emit VirtualAccountReused(reusedAccount, parentAccount);

		return reusedAccount;
	}

	/**
	 * @dev Creates a virtual account
	 */
	function _createVirtualAccount(
		address parentAccount,
		bytes memory metadata,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private returns (address virtualAccount) {
		SubAccountData storage parent = subAccounts[parentAccount];
		if (!parent.isExists) revert InvalidParent();

		uint256 nonce = ++subAccountVirtualNonces[parentAccount];
		virtualAccount = _generateVirtualAccountAddress(parentAccount, nonce);

		VirtualAccountData storage v = virtualAccounts[virtualAccount];
		v.isExists = true;
		v.metadata = metadata;
		v.parentAccount = parentAccount;
		v.isolationType = isolationType;
		v.symbolId = symbolId;

		subAccountToVirtualAccounts[parentAccount].add(virtualAccount);

		// If singleVAMode is enabled, track this as the active VA for this key
		if (parent.singleVAMode) {
			activeVAByKey[parentAccount][isolationType][symbolId] = virtualAccount;
		}

		ISymmio symmio = ISymmio(parent.symmioCore);

		ISymmio.BindState memory bindState = symmio.getBindState(parentAccount);
		if (bindState.status == ISymmio.BindStatus.BOUND) {
			symmio.setSigner(virtualAccount);
			symmio.bindToPartyB(bindState.partyB);
			symmio.setSigner(address(0));
		}

		_callHook(
			parent.affiliate,
			IAccountHubHook.onVirtualAccountCreation.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountCreation.selector, virtualAccount, parentAccount, metadata)
		);

		emit VirtualAccountCreated(virtualAccount, parentAccount);
	}

	/**
	 * @dev Deletes a virtual account and adds it to the reuse pool
	 */
	function _deleteVirtualAccount(address account) private {
		VirtualAccountData storage vData = virtualAccounts[account];
		if (!vData.isExists) revert AlreadyDeleted();
		if (vData.quoteIds.length() != 0) revert OpenPositionsExist();

		address parentAccount = vData.parentAccount;
		address core = getRelatedCore(parentAccount);

		_deallocateAndTransferBalance(account, parentAccount, core);

		vData.isExists = false;

		// Clear from activeVAByKey if this was the active VA for this key
		if (activeVAByKey[parentAccount][vData.isolationType][vData.symbolId] == account) {
			delete activeVAByKey[parentAccount][vData.isolationType][vData.symbolId];
		}

		// Add to the reuse pool (stack) and remove from active set
		deletedVirtualAccountsPool[parentAccount][vData.isolationType][vData.symbolId].push(account);
		subAccountToVirtualAccounts[parentAccount].remove(account);

		address affiliate = _getAffiliateForAccount(account);

		_callHook(
			affiliate,
			IAccountHubHook.onVirtualAccountDeletion.selector,
			abi.encodeWithSelector(IAccountHubHook.onVirtualAccountDeletion.selector, account)
		);

		emit VirtualAccountDeleted(account, parentAccount);
	}

	/**
	 * @dev Handles sendQuote for virtual accounts
	 */
	function _handleVirtualAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private returns (bytes memory) {
		VirtualAccountData storage accountData = virtualAccounts[account];
		VirtualAccountIsolationType isolationType = accountData.isolationType;

		if (
			(isolationType == VirtualAccountIsolationType.POSITION && accountData.quoteIds.length() > 0) ||
			(isolationType == VirtualAccountIsolationType.MARKET_LONG && p.positionType != ISymmio.PositionType.LONG) ||
			(isolationType == VirtualAccountIsolationType.MARKET_SHORT && p.positionType != ISymmio.PositionType.SHORT)
		) {
			revert PositionTypeNotAllowedForThisAccount();
		}

		if (
			(isolationType == VirtualAccountIsolationType.MARKET ||
				isolationType == VirtualAccountIsolationType.MARKET_LONG ||
				isolationType == VirtualAccountIsolationType.MARKET_SHORT) && p.symbolId != accountData.symbolId
		) {
			revert SymbolNotAllowedForThisAccount();
		}

		bytes memory result = _executeWithSigner(account, cd);
		accountData.quoteIds.add(ISymmio(getRelatedCore(account)).getNextQuoteId());
		return result;
	}

	/**
	 * @dev Handles sendQuote for sub-accounts
	 */
	function _handleSubAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private returns (bytes memory) {
		SubAccountData storage accountData = subAccounts[account];

		if (accountData.isolationType == SubAccountIsolationType.CUSTOM) {
			return _executeWithSigner(account, cd);
		}

		// Get or create virtual account based on sub-account isolation type (tries to reuse deleted ones first)
		address virtualAccount;
		if (accountData.isolationType == SubAccountIsolationType.POSITION) {
			virtualAccount = _getOrCreateVirtualAccount(account, hex"", VirtualAccountIsolationType.POSITION, p.symbolId);
		}

		if (accountData.isolationType == SubAccountIsolationType.MARKET)
			virtualAccount = _getOrCreateVirtualAccount(account, hex"", VirtualAccountIsolationType.MARKET, p.symbolId);

		if (accountData.isolationType == SubAccountIsolationType.MARKET_DIRECTION) {
			VirtualAccountIsolationType vType = p.positionType == ISymmio.PositionType.LONG
				? VirtualAccountIsolationType.MARKET_LONG
				: VirtualAccountIsolationType.MARKET_SHORT;

			virtualAccount = _getOrCreateVirtualAccount(account, hex"", vType, p.symbolId);
		}

		// send quote from virtual account
		bytes memory result = _executeWithSigner(virtualAccount, cd);
		virtualAccounts[virtualAccount].quoteIds.add(ISymmio(getRelatedCore(virtualAccount)).getNextQuoteId());
		return result;
	}

	/**
	 * @dev Deallocates and transfers balance from virtual account to parent account's balance
	 * @dev Uses internalTransferToBalance to transfer directly to parent's balance (not allocatedBalance)
	 * @dev This allows the parent to immediately use the funds for new virtual accounts
	 */
	function _deallocateAndTransferBalance(address account, address parentAccount, address core) private {
		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.zeroUpnlDeallocate.selector, allocatedBalance));
		}

		uint256 balance = ISymmio(core).balanceOf(account);
		if (balance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.internalTransferToBalance.selector, parentAccount, balance));
		}
	}

	/**
	 * @dev Executes a call with signer set
	 */
	function _executeWithSigner(address account, bytes memory callData) private returns (bytes memory) {
		address signer = getSigner();
		address core = getRelatedCore(account);

		ISymmio(core).setSigner(account);
		(bool success, bytes memory result) = core.call(callData);
		ISymmio(core).setSigner(address(0));

		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}

		emit Call(signer, account, callData, true, result);
		return result;
	}

	/**
	 * @dev Checks if user is owner of account
	 */
	function _isOwnerOf(address account, address user) private view returns (bool) {
		return _resolveAccountOwner(account) == user;
	}

	/**
	 * @dev Resolves the owner for sub accounts or legacy accounts
	 */
	function _resolveAccountOwner(address account) private view returns (address) {
		address owner = subAccounts[account].owner;
		if (owner != address(0)) {
			return owner;
		}

		// sub accounts
		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			address parentOwner = subAccounts[parent].owner;
			if (parentOwner != address(0)) {
				return parentOwner;
			}
		}

		// multi accounts
		address[] memory legacyAccounts = IAffiliateHub(affiliateHub).getLegacyMultiAccounts();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address legacyOwner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (legacyOwner != address(0)) {
				return legacyOwner;
			}
		}

		return address(0);
	}

	/**
	 * @dev Gets legacy core address
	 */
	function _getLegacyCore(address account) private view returns (address) {
		address[] memory legacyAccounts = IAffiliateHub(affiliateHub).getLegacyMultiAccounts();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address owner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyAccounts[i]).symmioAddress();
			}
		}
		revert UnableToRetrieveCore();
	}

	/**
	 * @dev Gets affiliate for an account
	 */
	function _getAffiliateForAccount(address account) private view returns (address) {
		if (subAccounts[account].isExists) {
			return subAccounts[account].affiliate;
		}

		if (virtualAccounts[account].parentAccount != address(0)) {
			return _getAffiliateForAccount(virtualAccounts[account].parentAccount);
		}

		return address(0);
	}

	/**
	 * @dev Calls a hook if configured
	 */
	function _callHook(address affiliate, bytes4 selector, bytes memory data) private {
		address hook = IAffiliateHub(affiliateHub).getHook(affiliate, selector);
		if (hook == address(0)) return;
		(bool success, bytes memory result) = hook.call(data);
		if (!success) {
			revert HookFailed(result);
		}
	}

	/**
	 * @dev Generates deterministic sub-account address
	 */
	function _generateSubAccountAddress(address affiliate, address user, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(user, nonce)), ACCOUNT_INIT_CODE_HASH)))
				)
			);
	}

	/**
	 * @dev Generates deterministic virtual account address
	 */
	function _generateVirtualAccountAddress(address parentAccount, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), parentAccount, keccak256(abi.encodePacked(nonce)), VIRTUAL_ACCOUNT_INIT_CODE_HASH))
					)
				)
			);
	}

	/**
	 * @dev Deploys account manager contract
	 */
	function _deployAccountManager(address user, string memory name) private returns (address accountManager) {
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, user, name));
		bytes memory bytecode = abi.encodePacked(accountManagerImplementation, abi.encode(address(this)));

		assembly {
			accountManager := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
		}

		if (accountManager == address(0)) revert DeploymentFailed();
	}

	/**
	 * @dev Generates deterministic account manager address
	 */
	function _generateAccountManagerAddress(address user, string memory name) private view returns (address) {
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, user, name));
		bytes memory bytecode = abi.encodePacked(accountManagerImplementation, abi.encode(address(this)));
		bytes32 initCodeHash = keccak256(bytecode);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
	}

	/**
	 * @dev Predicts the address of the next virtual account that will be created for a sub-account
	 */
	function _predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) private view returns (address) {
		// First check if a deleted virtual account exists for this combination
		address[] storage pool = deletedVirtualAccountsPool[subAccount][isolationType][symbolId];
		if (pool.length > 0) {
			return pool[pool.length - 1];
		}

		// If singleVAMode is enabled, check if there's already an active VA for this key
		if (subAccounts[subAccount].singleVAMode) {
			address existingVA = activeVAByKey[subAccount][isolationType][symbolId];
			if (existingVA != address(0) && virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		// If no deleted account exists, generate and return a new virtual account address
		uint256 nextNonce = subAccountVirtualNonces[subAccount] + 1;
		return _generateVirtualAccountAddress(subAccount, nextNonce);
	}
}
