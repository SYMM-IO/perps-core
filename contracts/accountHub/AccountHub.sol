// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity ^0.8.21;

import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IAccountHub.sol";
import "./interfaces/IAffiliateHub.sol";
import "./interfaces/ISymmio.sol";
import "./interfaces/IAccountHubHook.sol";
import "./interfaces/IMultiAccount.sol";

/**
 * @title AccountHub
 * @notice Manages sub-accounts and virtual accounts for the Symmio protocol
 * @dev Implements role-based access control, pausability, and reentrancy protection
 */
contract AccountHub is IAccountHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;

	// ==================== Constants ====================
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant SIGNER_SETTER = keccak256("SIGNER_SETTER");

	bytes4 private constant SEND_QUOTE_SELECTOR = 0x7f2755b2;
	bytes4 private constant SEND_QUOTE_WITH_AFFILIATE_SELECTOR = 0x40f1310c;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");

	uint256 public constant MAX_NAME_LENGTH = 100;

	// ==================== State Variables ====================

	mapping(address => SubAccountData) private subAccounts;
	mapping(address => VirtualAccountData) private virtualAccounts;
	mapping(address => EnumerableSet.AddressSet) private userToSubAccounts;
	mapping(address => EnumerableSet.AddressSet) private subAccountToVirtualAccounts;

	address public affiliateHub;
	address internal globalSigner;
	uint256 public globalNonce;

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
	 */
	function initialize(address _admin, address _affiliateHub) public initializer {
		if (_admin == address(0)) revert ZeroAddress();
		if (_affiliateHub == address(0)) revert ZeroAddress();

		__Pausable_init();
		__AccessControl_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);

		affiliateHub = _affiliateHub;
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
	 * @notice Executes arbitrary calls on behalf of an account
	 * @param account The account address
	 * @param callDatas Array of encoded function calls
	 */
	function _call(address account, bytes[] calldata callDatas) external whenNotPaused nonReentrant onlyAccountOwner(account) {
		if (callDatas.length == 0) revert EmptyArray();

		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata cd = callDatas[i];
			bytes4 selector = bytes4(cd[:4]);

			if (selector == SEND_QUOTE_SELECTOR || selector == SEND_QUOTE_WITH_AFFILIATE_SELECTOR) {
				QuoteParams memory p = _decodeQuoteParams(cd);

				if (virtualAccounts[account].isExists) {
					_handleVirtualAccountSendQuote(account, cd, p);
					return;
				}

				if (subAccounts[account].isExists) {
					_handleSubAccountSendQuote(account, cd, p);
					return;
				}
			}

			_executeWithSigner(account, cd);
		}
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
		VirtualAccountData storage vData = virtualAccounts[partyA];
		SubAccountData storage sData = subAccounts[partyA];

		if (vData.isExists) {
			vData.quoteIds.remove(quoteId);
			if (vData.quoteIds.length() == 0) {
				_deleteVirtualAccount(partyA);
			}
		}

		if (sData.isExists) {
			sData.quoteIds.remove(quoteId);
		}
	}

	// ==================== Admin Functions ====================

	/**
	 * @notice Sets the AffiliateHub contract address (only for emergency updates)
	 * @param _affiliateHub The new AffiliateHub address
	 */
	function setAffiliateHub(address _affiliateHub) external onlyRole(SETTER_ROLE) {
		if (_affiliateHub == address(0)) revert ZeroAddress();
		affiliateHub = _affiliateHub;
	}

	/**
	 * @notice Sets the global signer address
	 * @param _signer The new signer address
	 */
	function setSigner(address _signer) external onlyRole(SIGNER_SETTER) {
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
	 * @notice Gets all sub-accounts for an owner
	 * @param owner The owner address
	 * @return Array of sub-account addresses
	 */
	function getSubAccounts(address owner) external view returns (address[] memory) {
		return userToSubAccounts[owner].values();
	}

	/**
	 * @notice Gets all virtual accounts for a sub-account
	 * @param subAccount The sub-account address
	 * @return Array of virtual account addresses
	 */
	function getVirtualAccounts(address subAccount) external view returns (address[] memory) {
		return subAccountToVirtualAccounts[subAccount].values();
	}

	/**
	 * @notice Gets sub-account data
	 * @param account The account address
	 * @return owner The owner address
	 * @return isExists Whether the account exists
	 * @return name The account name
	 * @return affiliate The affiliate address
	 * @return symmioCore The symmioCore address
	 * @return metadata The metadata
	 * @return isolationType The isolation type
	 */
	function getSubAccountData(
		address account
	)
		external
		view
		returns (
			address owner,
			bool isExists,
			string memory name,
			address affiliate,
			address symmioCore,
			bytes memory metadata,
			SubAccountIsolationType isolationType
		)
	{
		SubAccountData storage s = subAccounts[account];
		return (s.owner, s.isExists, s.name, s.affiliate, s.symmioCore, s.metadata, s.isolationType);
	}

	/**
	 * @notice Gets quote IDs for a sub-account
	 * @param account The account address
	 * @return Array of quote IDs
	 */
	function getSubAccountQuoteIds(address account) external view returns (uint256[] memory) {
		return subAccounts[account].quoteIds.values();
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

		uint256 nonce = ++globalNonce;
		subAccountAddress = _generateSubAccountAddress(affiliate, sender, nonce);

		SubAccountData storage s = subAccounts[subAccountAddress];
		s.owner = sender;
		s.isExists = true;
		s.name = data.name;
		s.affiliate = affiliate;
		s.metadata = data.metadata;
		s.symmioCore = data.symmioCore;
		s.isolationType = data.isolationType;

		userToSubAccounts[sender].add(subAccountAddress);

		_callHook(affiliate, IAccountHubHook.onAccountCreation.selector, abi.encode(subAccountAddress, data.metadata));

		emit SubAccountCreated(subAccountAddress, sender, affiliate, data.name);
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

		uint256 nonce = ++globalNonce;
		virtualAccount = _generateVirtualAccountAddress(parentAccount, nonce);

		VirtualAccountData storage v = virtualAccounts[virtualAccount];
		v.isExists = true;
		v.metadata = metadata;
		v.parentAccount = parentAccount;
		v.isolationType = isolationType;
		v.symbolId = symbolId;

		subAccountToVirtualAccounts[parentAccount].add(virtualAccount);

		_callHook(parent.affiliate, IAccountHubHook.onVirtualAccountCreation.selector, abi.encode(virtualAccount, parentAccount));

		emit VirtualAccountCreated(virtualAccount, parentAccount);
	}

	/**
	 * @dev Deletes a virtual account
	 */
	function _deleteVirtualAccount(address account) private {
		VirtualAccountData storage vData = virtualAccounts[account];
		if (!vData.isExists) revert AlreadyDeleted();
		if (vData.quoteIds.length() != 0) revert OpenPositionsExist();

		address parentAccount = vData.parentAccount;
		address core = getRelatedCore(parentAccount);

		_deallocateAndTransferBalance(account, parentAccount, core);

		vData.isExists = false;

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IAccountHubHook.onVirtualAccountDeletion.selector, abi.encode(account));

		emit VirtualAccountDeleted(account, parentAccount);
	}

	/**
	 * @dev Decodes quote parameters from calldata
	 */
	function _decodeQuoteParams(bytes calldata cd) private pure returns (QuoteParams memory) {
		(, uint256 symbolId, ISymmio.PositionType positionType, , , , uint256 cva, uint256 lf, uint256 partyAmm, , , , , ) = abi.decode(
			cd[4:],
			(
				address[],
				uint256,
				ISymmio.PositionType,
				ISymmio.OrderType,
				uint256,
				uint256,
				uint256,
				uint256,
				uint256,
				uint256,
				uint256,
				uint256,
				address,
				ISymmio.SingleUpnlAndPriceSig
			)
		);

		return QuoteParams(symbolId, positionType, cva, lf, partyAmm);
	}

	/**
	 * @dev Handles sendQuote for virtual accounts
	 */
	function _handleVirtualAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private {
		VirtualAccountData storage accountData = virtualAccounts[account];
		VirtualAccountIsolationType isolationType = accountData.isolationType;

		if (
			isolationType == VirtualAccountIsolationType.POSITION ||
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

		_executeWithSigner(account, cd);
		accountData.quoteIds.add(ISymmio(getRelatedCore(account)).getNextQuoteId() - 1);
	}

	/**
	 * @dev Handles sendQuote for sub-accounts
	 */
	function _handleSubAccountSendQuote(address account, bytes memory cd, QuoteParams memory p) private {
		SubAccountData storage accountData = subAccounts[account];

		if (accountData.isolationType == SubAccountIsolationType.CUSTOM) {
			_executeWithSigner(account, cd);
			accountData.quoteIds.add(ISymmio(getRelatedCore(account)).getNextQuoteId() - 1);
			return;
		}

		// create virtual account based on sub-account isolation type
		address virtualAccount;
		if (accountData.isolationType == SubAccountIsolationType.POSITION)
			virtualAccount = _createVirtualAccount(account, hex"", VirtualAccountIsolationType.POSITION, p.symbolId);

		if (accountData.isolationType == SubAccountIsolationType.MARKET)
			virtualAccount = _createVirtualAccount(account, hex"", VirtualAccountIsolationType.MARKET, p.symbolId);

		if (accountData.isolationType == SubAccountIsolationType.MARKET_DIRECTION) {
			VirtualAccountIsolationType vType = p.positionType == ISymmio.PositionType.LONG
				? VirtualAccountIsolationType.MARKET_LONG
				: VirtualAccountIsolationType.MARKET_SHORT;

			virtualAccount = _createVirtualAccount(account, hex"", vType, p.symbolId);
		}

		// transfer funds to virtual account
		address core = getRelatedCore(virtualAccount);
		ISymmio(core).setSigner(account);
		ISymmio(core).internalTransfer(virtualAccount, p.cva + p.lf + p.partyAmm);
		ISymmio(core).setSigner(address(0));

		// send quote from virtual account
		_executeWithSigner(virtualAccount, cd);
		virtualAccounts[virtualAccount].quoteIds.add(ISymmio(getRelatedCore(virtualAccount)).getNextQuoteId() - 1);
	}

	/**
	 * @dev Deallocates and transfers balance from virtual account
	 */
	function _deallocateAndTransferBalance(address account, address parentAccount, address core) private {
		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.deallocate.selector, allocatedBalance));
		}

		uint256 balance = ISymmio(core).balanceOf(account);
		if (balance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parentAccount, balance));
		}
	}

	/**
	 * @dev Executes a call with signer set
	 */
	function _executeWithSigner(address account, bytes memory callData) private {
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
	}

	/**
	 * @dev Checks if user is owner of account
	 */
	function _isOwnerOf(address account, address user) private view returns (bool) {
		if (subAccounts[account].owner == user) {
			return true;
		}

		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return _isOwnerOf(parent, user);
		}

		return _checkLegacyOwnership(account, user);
	}

	/**
	 * @dev Checks legacy multi-account ownership
	 */
	function _checkLegacyOwnership(address account, address user) private view returns (bool) {
		address[] memory legacyAccounts = IAffiliateHub(affiliateHub).getLegacyMultiAccounts();
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			address owner = IMultiAccount(legacyAccounts[i]).owners(account);
			if (owner == user) {
				return true;
			}
		}
		return false;
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
		if (hook != address(0)) {
			(bool success, bytes memory result) = hook.call(abi.encodeWithSelector(selector, data));

			if (!success) {
				assembly {
					revert(add(result, 32), mload(result))
				}
			}
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
}
