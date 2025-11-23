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
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

import "./interfaces/IAccountHub.sol";
import "./interfaces/ISymmio.sol";
import "./interfaces/IHook.sol";
import "./interfaces/IMultiAccount.sol";

/**
 * @title AccountsHub
 * @notice Manages affiliate accounts, sub-accounts, and virtual accounts for the Symmio protocol
 * @dev Implements role-based access control, pausability, and reentrancy protection
 */
contract AccountsHub is IAccountHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;
	using EnumerableMap for EnumerableMap.AddressToUintMap;

	// ==================== Constants ====================
	bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant SIGNER_SETTER = keccak256("SIGNER_SETTER");
	bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

	bytes4 private constant SEND_QUOTE_SELECTOR = 0x7f2755b2;
	bytes4 private constant SEND_QUOTE_WITH_AFFILIATE_SELECTOR = 0x40f1310c;
	// TODO ::: add SEND_QUOTE_WITH_AFFILIATE_AND_DATA_SELECTOR

	uint256 private constant SHARE_PRECISION = 1e18;
	uint256 private constant MAX_NAME_LENGTH = 100;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	bytes32 private constant VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH = keccak256("VFD_V1");
	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");

	// ==================== State Variables ====================
	address public symmioFeeReceiver;
	bytes public accountManagerImplementation;
	address internal globalSigner;
	uint256 public globalNonce;

	mapping(address => bool) private availableCores;
	mapping(address => AffiliateData) private affiliates;
	mapping(address => PendingFeeUpdate) public pendingFeeUpdates;
	mapping(address => SubAccountData) private subAccounts;
	mapping(address => VirtualAccountData) private virtualAccounts;
	mapping(address => EnumerableSet.AddressSet) private userToSubAccounts;
	mapping(address => EnumerableSet.AddressSet) private subAccountToVirtualAccounts;

	EnumerableSet.AddressSet private affiliateAddresses;
	EnumerableSet.AddressSet private legacyMultiAccounts;

	bytes32 internal initAccountManagerCodeHash;

	// ==================== Modifiers ====================

	/**
	 * @dev Ensures the caller is the affiliate admin
	 */
	modifier onlyAffiliateAdmin(address affiliate) {
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();
		_;
	}

	/**
	 * @dev Ensures the affiliate is in active state
	 */
	modifier onlyIfAffiliateIsActive(address affiliate) {
		if (affiliates[affiliate].state != AffiliateState.ACTIVE) {
			revert AffiliateNotActive();
		}
		_;
	}

	/**
	 * @dev Ensures the caller is a registered Symmio core
	 */
	modifier onlySymmio() {
		if (!availableCores[msg.sender]) revert NotSymmioCore();
		_;
	}

	// ==================== Constructor & Initializer ====================

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initializes the AccountsHub contract
	 * @param _admin The default admin address
	 * @param _symmioFeeReceiver The address to receive Symmio fees
	 * @param _accountManagerImplementation The bytecode for account manager deployment
	 */
	function initialize(address _admin, address _symmioFeeReceiver, bytes memory _accountManagerImplementation) public initializer {
		if (_admin == address(0)) revert ZeroAddress();
		if (_symmioFeeReceiver == address(0)) revert ZeroAddress();
		if (_accountManagerImplementation.length == 0) revert EmptyArray();

		__Pausable_init();
		__AccessControl_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);

		symmioFeeReceiver = _symmioFeeReceiver;
		accountManagerImplementation = _accountManagerImplementation;
		initAccountManagerCodeHash = keccak256(abi.encodePacked(accountManagerImplementation));
	}

	// ==================== Affiliate Management ====================

	/**
	 * @notice Requests to register a new affiliate
	 * @param reg The affiliate registration data
	 * @return affiliateAddress The generated affiliate address
	 */
	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external whenNotPaused returns (address affiliateAddress) {
		affiliateAddress = _generateAccountManagerAddress(reg.name);

		_validateAffiliateRegistration(affiliateAddress, reg);

		AffiliateData storage affiliate = affiliates[affiliateAddress];
		affiliate.name = reg.name;
		affiliate.brandColor = reg.brandColor;
		affiliate.admin = reg.admin;
		affiliate.state = AffiliateState.PENDING;
		affiliate.feeDetails.symmioShare = reg.symmioShare;
		affiliate.metadata = reg.metadata;
		affiliate.feeDetails.stakeholders = reg.stakeholders;
		affiliate.legacyMultiAccounts = reg.legacyMultiAccounts;

		for (uint256 i = 0; i < reg.symmioCores.length; i++) {
			if (!availableCores[reg.symmioCores[i]]) revert InvalidCore();
			affiliate.symmioCores.add(reg.symmioCores[i]);
		}

		emit AffiliateRegistered(affiliateAddress, reg.name);
	}

	/**
	 * @notice Cancels a pending affiliate registration
	 * @param affiliate The affiliate address
	 */
	function cancelRegistration(address affiliate) external onlyAffiliateAdmin(affiliate) {
		if (affiliates[affiliate].state != AffiliateState.PENDING) {
			revert NotPending();
		}
		delete affiliates[affiliate];
		emit RegistrationCancelled(affiliate);
	}

	/**
	 * @notice Approves a pending affiliate registration
	 * @param affiliate The affiliate address to approve
	 */
	function approveAffiliate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		if (affiliates[affiliate].state != AffiliateState.PENDING) {
			revert NotPending();
		}

		address accountManager = _deployAccountManager(affiliates[affiliate].name);
		if (affiliate != accountManager) revert(); // TODO ::: define a custom error
		address feeDistributor = _generateFeeDistributorAddress(affiliate, ++globalNonce);

		grantRole(SIGNER_SETTER, accountManager);

		_configureSymmioCores(affiliate, feeDistributor);

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		affiliates[affiliate].accountManager = accountManager;
		affiliates[affiliate].feeDistributor = feeDistributor;

		affiliateAddresses.add(accountManager);

		address[] memory legacyAccounts = affiliates[affiliate].legacyMultiAccounts;
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			legacyMultiAccounts.add(legacyAccounts[i]);
			address symm = IMultiAccount(legacyAccounts[i]).symmioAddress();
			if (!affiliates[affiliate].symmioCores.contains(symm)) {
				ISymmio(symm).setFeeCollector(legacyAccounts[i], feeDistributor);
			}
		}

		emit AffiliateApproved(affiliate, accountManager);
	}

	/**
	 * @notice Proposes a transfer of affiliate admin role
	 * @param affiliate The affiliate address
	 * @param newAdmin The proposed new admin address
	 */
	function proposeAdminTransfer(address affiliate, address newAdmin) external onlyIfAffiliateIsActive(affiliate) onlyAffiliateAdmin(affiliate) {
		if (newAdmin == address(0)) revert ZeroAddress();

		affiliates[affiliate].pendingAdmin = newAdmin;
		emit AdminTransferProposed(affiliate, newAdmin);
	}

	/**
	 * @notice Accepts the pending admin transfer
	 * @param affiliate The affiliate address
	 */
	function acceptAdminTransfer(address affiliate) external {
		if (affiliates[affiliate].pendingAdmin != msg.sender) {
			revert Unauthorized();
		}

		address oldAdmin = affiliates[affiliate].admin;
		affiliates[affiliate].admin = msg.sender;
		affiliates[affiliate].pendingAdmin = address(0);

		emit AdminTransferCompleted(affiliate, oldAdmin, msg.sender);
	}

	/**
	 * @notice Cancels the pending admin transfer
	 * @param affiliate The affiliate address
	 */
	function cancelAdminTransfer(address affiliate) external onlyAffiliateAdmin(affiliate) {
		affiliates[affiliate].pendingAdmin = address(0);
		emit AdminTransferCancelled(affiliate);
	}

	/**
	 * @notice Updates affiliate display details
	 * @param affiliate The affiliate address
	 * @param name The new name
	 * @param brandColor The new brand color
	 */
	function updateAffiliateDetails(
		address affiliate,
		string memory name,
		string memory brandColor
	) external onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		_validateName(name);

		affiliates[affiliate].name = name;
		affiliates[affiliate].brandColor = brandColor;

		emit AffiliateUpdated(affiliate, name, brandColor);
	}

	/**
	 * @notice Pauses an active affiliate
	 * @param affiliate The affiliate address
	 */
	function pauseAffiliate(address affiliate) external onlyIfAffiliateIsActive(affiliate) {
		if (!hasRole(PAUSER_ROLE, msg.sender) && affiliates[affiliate].admin != msg.sender) {
			revert Unauthorized();
		}

		affiliates[affiliate].state = AffiliateState.PAUSED;
		emit AffiliatePaused(affiliate, true);
	}

	/**
	 * @notice Unpauses a paused affiliate
	 * @param affiliate The affiliate address
	 */
	function unpauseAffiliate(address affiliate) external onlyRole(UNPAUSER_ROLE) {
		if (affiliates[affiliate].state != AffiliateState.PAUSED) {
			revert NotPaused();
		}

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		emit AffiliatePaused(affiliate, false);
	}

	// ==================== Fee Management ====================

	/**
	 * @notice Requests an update to affiliate fee distribution
	 * @param affiliate The affiliate address
	 * @param newStakeholders The new stakeholder configuration
	 * @param newSymmioShare The new Symmio share
	 */
	function requestFeeUpdate(
		address affiliate,
		Stakeholder[] memory newStakeholders,
		uint256 newSymmioShare
	) external onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		_validateFeeShares(newStakeholders, newSymmioShare);

		PendingFeeUpdate storage pending = pendingFeeUpdates[affiliate];
		pending.symmioShare = newSymmioShare;
		pending.timestamp = block.timestamp;
		pending.exists = true;
		pending.stakeholders = newStakeholders;

		emit StakeholdersUpdateRequested(affiliate);
	}

	/**
	 * @notice Cancels a pending fee update
	 * @param affiliate The affiliate address
	 */
	function cancelFeeUpdate(address affiliate) external onlyAffiliateAdmin(affiliate) {
		if (!pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		delete pendingFeeUpdates[affiliate];
		emit FeeUpdateCancelled(affiliate);
	}

	/**
	 * @notice Approves a pending fee update
	 * @param affiliate The affiliate address
	 */
	function approveFeeUpdate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		if (!pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		delete affiliates[affiliate].feeDetails.stakeholders;
		affiliates[affiliate].feeDetails.symmioShare = pendingFeeUpdates[affiliate].symmioShare;
		affiliates[affiliate].feeDetails.stakeholders = pendingFeeUpdates[affiliate].stakeholders;

		delete pendingFeeUpdates[affiliate];
		emit StakeholdersUpdated(affiliate);
	}

	/**
	 * @notice Claims all available fees for an affiliate
	 * @param affiliate The affiliate address
	 * @param symmio The Symmio core address
	 */
	function claimAllFees(address affiliate, address symmio) external whenNotPaused nonReentrant {
		uint256 claimable = _getClaimableFee(affiliate, symmio);
		claimFees(affiliate, symmio, claimable);
	}

	/**
	 * @notice Claims a specific amount of fees for an affiliate
	 * @param affiliate The affiliate address
	 * @param symmio The Symmio core address
	 * @param amount The amount to claim
	 */
	function claimFees(address affiliate, address symmio, uint256 amount) public whenNotPaused nonReentrant {
		address collateral = ISymmio(symmio).getCollateral();
		AffiliateData storage affiliateData = affiliates[affiliate];

		Stakeholder[] memory stakeHolders = new Stakeholder[](affiliateData.feeDetails.stakeholders.length + 1);

		// copy existing
		for (uint256 i = 0; i < affiliateData.feeDetails.stakeholders.length; i++) {
			stakeHolders[i] = affiliateData.feeDetails.stakeholders[i];
		}

		// append new one
		stakeHolders[stakeHolders.length - 1] = Stakeholder({ receiver: symmioFeeReceiver, share: affiliateData.feeDetails.symmioShare });
		_authorizeFeeClaim(stakeHolders);

		_withdrawFeesFromSymmio(symmio, affiliateData.feeDistributor, amount);
		_distributeFees(collateral, stakeHolders, amount);

		emit FeesClaimed(amount);
	}

	/**
	 * @notice Simulates fee claim to preview distribution
	 * @param affiliate The affiliate address
	 * @param symmio The Symmio core address
	 * @return holders Array of recipient addresses
	 * @return shares Array of corresponding share amounts
	 */
	function dryClaimAllFees(address affiliate, address symmio) public view returns (address[] memory holders, uint256[] memory shares) {
		uint256 totalClaimable = _getClaimableFee(affiliate, symmio);
		AffiliateData storage affiliateData = affiliates[affiliate];

		Stakeholder[] storage stored = affiliateData.feeDetails.stakeholders;
		uint256 storedLen = stored.length;

		Stakeholder[] memory stakeHolders = new Stakeholder[](storedLen + 1);

		for (uint256 i = 0; i < storedLen; i++) {
			stakeHolders[i] = stored[i];
		}

		stakeHolders[storedLen] = Stakeholder({ receiver: symmioFeeReceiver, share: affiliateData.feeDetails.symmioShare });

		uint256 len = stakeHolders.length;
		holders = new address[](len);
		shares = new uint256[](len);

		for (uint256 i = 0; i < len; i++) {
			holders[i] = stakeHolders[i].receiver;
			shares[i] = (stakeHolders[i].share * totalClaimable) / SHARE_PRECISION;
		}

		return (holders, shares);
	}

	// ==================== Account Management ====================

	/**
	 * @notice Creates multiple sub-accounts in a single transaction
	 * @param affiliate The affiliate address
	 * @param accountsData Array of account creation data
	 * @return Array of created account addresses
	 */
	function batchCreateSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		if (accountsData.length == 0) revert EmptyArray();

		address[] memory createdAccounts = new address[](accountsData.length);
		address signer = getSigner();

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = _createSubAccount(affiliate, signer, accountsData[i]);

			if (accountsData[i].initialDeposit > 0) {
				_depositForAccount(createdAccounts[i], accountsData[i].initialDeposit);
			}
		}

		return createdAccounts;
	}

	/**
	 * @notice Edits the name of an existing account
	 * @param account The account address
	 * @param name The new name
	 */
	function editAccountName(address account, string memory name) external whenNotPaused {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();

		_validateName(name);

		if (!subAccounts[account].isExists) revert AccountDoesNotExist();

		subAccounts[account].name = name;
		emit EditAccountName(signer, account, name);
	}

	/**
	 * @notice Deposits collateral for an account
	 * @param account The account address
	 * @param amount The amount to deposit
	 */
	function depositForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		_validateAccountOwnership(account, amount);
		_depositForAccount(account, amount);
	}

	/**
	 * @notice Allocates balance for trading in an account
	 * @param account The account address
	 * @param amount The amount to allocate
	 */
	function allocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		_validateAccountOwnership(account, amount);
		_allocateForAccount(account, amount);
	}

	/**
	 * @notice Deposits and allocates in a single transaction
	 * @param account The account address
	 * @param amount The amount to deposit and allocate
	 */
	function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		_validateAccountOwnership(account, amount);
		_depositAndAllocateForAccount(account, amount);
	}

	/**
	 * @notice Withdraws collateral from an account
	 * @param account The account address
	 * @param amount The amount to withdraw
	 */
	function withdrawFromAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		_validateAccountOwnership(account, amount);
		_withdrawFromAccount(account, amount);
	}

	/**
	 * @notice Executes arbitrary calls on behalf of an account
	 * @param account The account address
	 * @param callDatas Array of encoded function calls
	 */
	function _call(address account, bytes[] calldata callDatas) external whenNotPaused nonReentrant {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (callDatas.length == 0) revert EmptyArray();

		for (uint256 i = 0; i < callDatas.length; i++) {
			_processCall(account, callDatas[i]);
		}
	}

	// ==================== Hook Management ====================

	/**
	 * @notice Sets a hook for specific function calls
	 * @param affiliate The affiliate address
	 * @param selector The function selector to hook
	 * @param hook The hook contract address
	 */
	function setHook(address affiliate, bytes4 selector, address hook) external {
		if (affiliates[affiliate].state != AffiliateState.ACTIVE) {
			revert AffiliateNotActive();
		}
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();

		affiliates[affiliate].hooks[selector] = hook;
		emit HookSet(affiliate, selector, hook);
	}

	/**
	 * @notice Removes a hook
	 * @param affiliate The affiliate address
	 * @param selector The function selector to unhook
	 */
	function removeHook(address affiliate, bytes4 selector) external {
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();

		delete affiliates[affiliate].hooks[selector];
		emit HookRemoved(affiliate, selector);
	}

	// ==================== Symmio Callback ====================

	/**
	 * @notice Callback from Symmio when a position is closed
	 * @param quoteId The quote ID
	 * @param _filledAmount The filled amount
	 * @param _closedPrice The closing price
	 * @param partyA The party A address
	 * @param _partyB The party B address
	 */
	function onClosePosition(
		uint256 quoteId,
		uint256 _filledAmount,
		uint256 _closedPrice,
		address partyA,
		address _partyB
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
	 * @notice Sets the Symmio fee receiver address
	 * @param receiver The new receiver address
	 */
	function setSymmioFeeReceiver(address receiver) external onlyRole(SETTER_ROLE) {
		if (receiver == address(0)) revert ZeroAddress();

		address oldReceiver = symmioFeeReceiver;
		symmioFeeReceiver = receiver;

		emit SymmioFeeReceiverUpdated(oldReceiver, receiver);
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
	 * @notice Sets or unsets a core as available
	 * @param core The core address
	 * @param status The availability status
	 */
	function setAvailableCore(address core, bool status) external onlyRole(SETTER_ROLE) {
		availableCores[core] = status;
		emit AvailableCoreSet(core, status);
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
			return subAccounts[account].relatedCore;
		}

		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return getRelatedCore(parent);
		}

		return _getLegacyCore(account);
	}

	/**
	 * @notice Gets all Symmio cores for an affiliate
	 * @param aff The affiliate address
	 * @return Array of core addresses
	 */
	function affiliateSymmioCores(address aff) external view returns (address[] memory) {
		EnumerableSet.AddressSet storage set = affiliates[aff].symmioCores;
		uint256 len = set.length();

		address[] memory cores = new address[](len);

		for (uint256 i = 0; i < len; i++) {
			cores[i] = set.at(i);
		}

		return cores;
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
	 * @notice Gets all registered affiliates
	 * @return Array of affiliate addresses
	 */
	function getAllAffiliates() external view returns (address[] memory) {
		return affiliateAddresses.values();
	}

	/**
	 * @notice Gets the total number of affiliates
	 * @return The affiliate count
	 */
	function getAffiliateCount() external view returns (uint256) {
		return affiliateAddresses.length();
	}

	// ==================== Internal Functions ====================

	/**
	 * @dev Validates affiliate registration data
	 */
	function _validateAffiliateRegistration(address affiliateAddress, AffiliateRegistration memory reg) private view {
		if (affiliates[affiliateAddress].state != AffiliateState.NONE) {
			revert AlreadyRegistered();
		}
		if (reg.admin == address(0)) revert ZeroAddress();

		_validateName(reg.name);
		_validateFeeShares(reg.stakeholders, reg.symmioShare);
	}

	/**
	 * @dev Validates name length
	 */
	function _validateName(string memory name) private pure {
		if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LENGTH) {
			revert InvalidNameLength();
		}
	}

	/**
	 * @dev Validates fee shares sum to 100%
	 */
	function _validateFeeShares(Stakeholder[] memory stakeholders, uint256 symmioShare) private pure {
		if (symmioShare > SHARE_PRECISION) revert InvalidShare();

		uint256 totalShare = symmioShare;
		for (uint256 i = 0; i < stakeholders.length; i++) {
			if (stakeholders[i].receiver == address(0)) revert ZeroAddress();
			totalShare += stakeholders[i].share;
		}

		if (totalShare != SHARE_PRECISION) revert SharesMustSumTo100();
	}

	/**
	 * @dev Configures Symmio cores for an affiliate
	 */
	function _configureSymmioCores(address affiliate, address feeDistributor) private {
		EnumerableSet.AddressSet storage cores = affiliates[affiliate].symmioCores;

		for (uint256 i = 0; i < cores.length(); i++) {
			// TODO ::: set fee collector in try-catch to not revert if a specific core setFeeCollector method paused
			ISymmio(cores.at(i)).setFeeCollector(affiliate, feeDistributor);
		}
	}

	/**
	 * @dev Creates a single sub-account
	 */
	function _createSubAccount(address affiliate, address signer, SubAccountCreationData memory data) private returns (address subAccountAddress) {
		_validateName(data.name);
		if (!availableCores[data.relatedCore]) revert InvalidCore();

		uint256 nonce = ++globalNonce;
		subAccountAddress = _generateSubAccountAddress(affiliate, signer, nonce);

		SubAccountData storage s = subAccounts[subAccountAddress];
		s.owner = signer;
		s.isExists = true;
		s.name = data.name;
		s.affiliate = affiliate;
		s.metadata = data.metadata;
		s.relatedCore = data.relatedCore;
		s.isolationType = data.isolationType;

		userToSubAccounts[signer].add(subAccountAddress);

		_callHook(affiliate, IHooks.onAccountCreation.selector, abi.encode(subAccountAddress, data.metadata));

		emit SubAccountCreated(subAccountAddress, signer, affiliate, data.name);
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

		_callHook(parent.affiliate, IHooks.onVirtualAccountCreation.selector, abi.encode(virtualAccount, parentAccount));

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
		_callHook(affiliate, IHooks.onVirtualAccountDeletion.selector, abi.encode(account));

		emit VirtualAccountDeleted(account, parentAccount);
	}

	/**
	 * @dev Validates account ownership and amount
	 */
	function _validateAccountOwnership(address account, uint256 amount) private view {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (amount == 0) revert ZeroAmount();
	}

	/**
	 * @dev Deposits collateral for an account
	 */
	function _depositForAccount(address account, uint256 amount) private {
		address signer = getSigner();
		address core = getRelatedCore(account);
		address collateral = ISymmio(core).getCollateral();

		IERC20Upgradeable(collateral).safeTransferFrom(signer, address(this), amount);
		IERC20Upgradeable(collateral).safeIncreaseAllowance(core, amount);

		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.depositFor.selector, account, amount));

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onDeposit.selector, abi.encode(account, amount));

		emit DepositForAccount(signer, account, amount);
	}

	/**
	 * @dev Allocates balance for an account
	 */
	function _allocateForAccount(address account, uint256 amount) private {
		address signer = getSigner();
		address core = getRelatedCore(account);
		address collateral = ISymmio(core).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();

		if (decimals > 18) revert InvalidTokenDecimals();

		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** decimals);

		ISymmio(core).setSigner(account);
		ISymmio(core).allocate(amount);
		ISymmio(core).setSigner(address(0));

		emit AllocateForAccount(signer, account, amountWith18Decimals);
	}

	/**
	 * @dev Deposits and allocates in one call
	 */
	function _depositAndAllocateForAccount(address account, uint256 amount) private {
		_depositForAccount(account, amount);
		_allocateForAccount(account, amount);
	}

	/**
	 * @dev Withdraws from an account
	 */
	function _withdrawFromAccount(address account, uint256 amount) private {
		address signer = getSigner();
		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.withdrawTo.selector, signer, amount));

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onWithdraw.selector, abi.encode(account, amount));

		emit WithdrawFromAccount(signer, account, amount);
	}

	/**
	 * @dev Processes a call to an account
	 */
	function _processCall(address account, bytes calldata cd) private {
		bytes4 selector = bytes4(cd[:4]);
		bool isSendQuote = (selector == SEND_QUOTE_SELECTOR || selector == SEND_QUOTE_WITH_AFFILIATE_SELECTOR);

		if (isSendQuote) {
			// TODO ::: check decode for both selector
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
		VirtualAccountData storage vData = virtualAccounts[account];

		if (vData.isolationType == VirtualAccountIsolationType.CUSTOM) {
			_executeWithSigner(account, cd);
			address core = getRelatedCore(account);
			uint256 quoteId = ISymmio(core).getNextQuoteId() - 1;
			vData.quoteIds.add(quoteId);
			return;
		}

		_validateVirtualAccountQuote(vData, p);

		_executeWithSigner(account, cd);

		address core = getRelatedCore(account);
		uint256 quoteId = ISymmio(core).getNextQuoteId() - 1;
		vData.quoteIds.add(quoteId);
	}

	/**
	 * @dev Validates virtual account quote parameters
	 */
	function _validateVirtualAccountQuote(VirtualAccountData storage vData, QuoteParams memory p) private view {
		if (vData.isolationType == VirtualAccountIsolationType.POSITION) {
			revert();
		}

		if (vData.isolationType == VirtualAccountIsolationType.MARKET_LONG && p.positionType != ISymmio.PositionType.LONG) {
			revert();
		}

		if (vData.isolationType == VirtualAccountIsolationType.MARKET_SHORT && p.positionType != ISymmio.PositionType.SHORT) {
			revert();
		}

		if (
			vData.isolationType == VirtualAccountIsolationType.MARKET ||
			vData.isolationType == VirtualAccountIsolationType.MARKET_LONG ||
			vData.isolationType == VirtualAccountIsolationType.MARKET_SHORT
		) {
			if (p.symbolId != vData.symbolId) revert();
		}
	}

	/**
	 * @dev Handles sendQuote for sub-accounts
	 */
	function _handleSubAccountSendQuote(address parentAccount, bytes memory cd, QuoteParams memory p) private {
		SubAccountData storage parent = subAccounts[parentAccount];

		if (parent.isolationType == SubAccountIsolationType.CUSTOM) {
			_executeWithSigner(parentAccount, cd);
			address core = getRelatedCore(parentAccount);
			uint256 quoteId = ISymmio(core).getNextQuoteId() - 1;
			parent.quoteIds.add(quoteId);
			return;
		}

		address virtualAccount = _createVirtualAccountForSubAccount(parentAccount, p, parent.isolationType);

		_transferToVirtualAccount(virtualAccount, parentAccount, p);

		_executeWithSigner(virtualAccount, cd);

		address core = getRelatedCore(virtualAccount);
		uint256 quoteId = ISymmio(core).getNextQuoteId() - 1;
		virtualAccounts[virtualAccount].quoteIds.add(quoteId);
	}

	/**
	 * @dev Creates virtual account based on sub-account isolation type
	 */
	function _createVirtualAccountForSubAccount(
		address parentAccount,
		QuoteParams memory p,
		SubAccountIsolationType isolationType
	) private returns (address) {
		if (isolationType == SubAccountIsolationType.POSITION) {
			return _createVirtualAccount(parentAccount, hex"", VirtualAccountIsolationType.POSITION, p.symbolId);
		}

		if (isolationType == SubAccountIsolationType.MARKET) {
			return _createVirtualAccount(parentAccount, hex"", VirtualAccountIsolationType.MARKET, p.symbolId);
		}

		if (isolationType == SubAccountIsolationType.MARKET_DIRECTION) {
			VirtualAccountIsolationType vType = p.positionType == ISymmio.PositionType.LONG
				? VirtualAccountIsolationType.MARKET_LONG
				: VirtualAccountIsolationType.MARKET_SHORT;

			return _createVirtualAccount(parentAccount, hex"", vType, p.symbolId);
		}
	}

	/**
	 * @dev Transfers funds to virtual account
	 */
	function _transferToVirtualAccount(address virtualAccount, address signer, QuoteParams memory p) private {
		address core = getRelatedCore(virtualAccount);
		ISymmio(core).setSigner(signer);
		ISymmio(core).internalTransfer(virtualAccount, p.cva + p.lf + p.partyAmm);
		ISymmio(core).setSigner(address(0));
	}

	/**
	 * @dev Deallocates and transfers balance from virtual account
	 */
	function _deallocateAndTransferBalance(address account, address parentAccount, address core) private {
		address collateral = ISymmio(core).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();

		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.deallocate.selector, allocatedBalance)); // TODO ::: change it to use deallocateForZeroUpnl
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
	 * @dev Gets claimable fees
	 */
	function _getClaimableFee(address affiliate, address symmio) private view returns (uint256) {
		address collateral = ISymmio(symmio).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		AffiliateData storage affiliateData = affiliates[affiliate];
		uint256 balance = ISymmio(symmio).balanceOf(affiliateData.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	/**
	 * @dev Authorizes fee claim
	 */
	function _authorizeFeeClaim(Stakeholder[] memory stakeholders) private view {
		address signer = getSigner();
		bool auth = false;

		for (uint256 i = 0; i < stakeholders.length; i++) {
			if (signer == stakeholders[i].receiver) {
				auth = true;
				break;
			}
		}

		if (!auth && !hasRole(DISTRIBUTOR_ROLE, signer)) {
			revert Unauthorized();
		}
	}

	/**
	 * @dev Withdraws fees from Symmio
	 */
	function _withdrawFeesFromSymmio(address symmio, address feeDistributor, uint256 amount) private {
		ISymmio(symmio).setSigner(feeDistributor);
		ISymmio(symmio).withdrawTo(address(this), amount);
		ISymmio(symmio).setSigner(address(0));
	}

	/**
	 * @dev Distributes fees to stakeholders
	 */
	function _distributeFees(address collateral, Stakeholder[] memory stakeholders, uint256 amount) private {
		uint256 checkAmount = 0;

		for (uint256 i = 0; i < stakeholders.length; i++) {
			uint256 share = (stakeholders[i].share * amount) / SHARE_PRECISION;
			IERC20Upgradeable(collateral).safeTransfer(stakeholders[i].receiver, share);
			checkAmount += share;
			emit FeesDistributed(stakeholders[i].receiver, share);
		}

		if (checkAmount != amount) revert InvalidAmount();
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
		uint256 len = legacyMultiAccounts.length();
		for (uint256 i = 0; i < len; i++) {
			address owner = IMultiAccount(legacyMultiAccounts.at(i)).owners(account);
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
		uint256 len = legacyMultiAccounts.length();
		for (uint256 i = 0; i < len; i++) {
			address owner = IMultiAccount(legacyMultiAccounts.at(i)).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyMultiAccounts.at(i)).symmioAddress();
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
		address hook = affiliates[affiliate].hooks[selector];
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
	 * @dev Deploys account manager contract
	 */
	function _deployAccountManager(string memory name) private returns (address accountManager) {
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, name));
		bytes memory bytecode = abi.encodePacked(accountManagerImplementation, abi.encode(address(this)));

		accountManager;
		assembly {
			accountManager := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
		}

		if (accountManager == address(0)) revert DeploymentFailed();
	}

	/**
	 * @dev Generates deterministic account manager address
	 */
	function _generateAccountManagerAddress(string memory name) private view returns (address) {
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, name));

		bytes memory bytecode = abi.encodePacked(accountManagerImplementation, abi.encode(address(this)));

		bytes32 initCodeHash = keccak256(bytecode);

		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
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
	 * @dev Generates deterministic fee distributor address
	 */
	function _generateFeeDistributorAddress(address affiliate, uint256 nonce) private pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(nonce)), VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH))
					)
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
