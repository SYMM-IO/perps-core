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
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

import "./interfaces/IAccountHub.sol";
import "./interfaces/ISymmio.sol";
import "./interfaces/IAccountManager.sol";
import "./interfaces/IHook.sol";
import "./interfaces/IMultiAccount.sol";

contract AccountsHub is IAccountHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableMap for EnumerableMap.AddressToUintMap;

	// ==================== Constants ====================
	bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant SIGNER_SETTER = keccak256("SIGNER_SETTER");
	bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
	bytes4 constant SEND_QUOTE_SELECTOR = 0x40f1310c;

	uint256 private constant MAX_POSITION_QUERY_LIMIT = 50;

	// ==================== Storage ====================
	address public symmioFeeReceiver;
	bytes public accountManagerImplementation;

	mapping(address => bool) availableCores;

	mapping(address => AffiliateData) public affiliates;
	EnumerableSet.AddressSet private affiliateAddresses;
	mapping(address => PendingFeeUpdate) public pendingFeeUpdates;

	// Account related storage
	mapping(address => SubAccountData) public subAccounts;
	mapping(address => VirtualAccountData) public virtualAccounts;
	mapping(address => EnumerableSet.AddressSet) private userToSubAccounts;
	mapping(address => EnumerableSet.AddressSet) private subAccountToVirtualAccounts;
	address internal globalSigner;
	uint256 public globalNonce;

	EnumerableSet.AddressSet private legacyMultiAccounts;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACC_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VACC_V1");
	bytes32 private constant VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH = keccak256("VFD_V1");

	modifier onlyAffiliateAdmin(address affiliate, address sender) {
		if (affiliates[affiliate].admin != sender) revert NotAdmin();
		_;
	}

	modifier onlyIfAffiliateIsActive(address affiliate) {
		if (affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();
		_;
	}

	modifier onlySymmio() {
		if (!availableCores[msg.sender]) revert NotSymmioCore();
		_;
	}

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

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
	}

	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external whenNotPaused returns (address) {
		address aff = _generateAccountManagerAddress(reg.name);
		if (affiliates[aff].state != AffiliateState.NONE) revert AlreadyRegistered();
		if (reg.admin == address(0)) revert ZeroAddress();
		if (bytes(reg.name).length == 0 || bytes(reg.name).length > 100) revert InvalidNameLength();
		if (reg.symmioShare > 1e18) revert InvalidShare();

		uint256 totalShare = reg.symmioShare;
		for (uint256 i = 0; i < reg.stakeholders.length; i++) {
			if (reg.stakeholders[i].receiver == address(0)) revert ZeroAddress();
			totalShare += reg.stakeholders[i].share;
		}
		if (totalShare != 1e18) revert SharesMustSumTo100();

		AffiliateData storage affiliate = affiliates[aff];
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
			affiliate.symmioCores.push(reg.symmioCores[i]);
		}

		emit AffiliateRegistered(aff, reg.name);
		return aff;
	}

	function cancelRegistration(address affiliate) external onlyAffiliateAdmin(affiliate, msg.sender) {
		if (affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();
		delete affiliates[affiliate];
		emit RegistrationCancelled(affiliate);
	}

	function approveAffiliate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		if (affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();

		// Deploy Account Manager for this affiliate
		address accountManager = _deployAccountManager(affiliates[affiliate].admin);
		address feeDistributor = _generateFeeDistributorAddress(affiliate, globalNonce++);
		grantRole(SIGNER_SETTER, accountManager);
		for (uint256 i = 0; i < affiliates[affiliate].symmioCores.length; i++) {
			ISymmio(affiliates[affiliate].symmioCores[i]).setFeeCollector(affiliate, feeDistributor);
		}

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		affiliates[affiliate].accountManager = accountManager;
		affiliates[affiliate].feeDistributor = feeDistributor;

		affiliateAddresses.add(accountManager);

		address[] memory legacyAccounts = affiliates[affiliate].legacyMultiAccounts;
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			legacyMultiAccounts.add(legacyAccounts[i]);
			address symm = IMultiAccount(legacyAccounts[i]).symmioAddress();
			ISymmio(symm).setFeeCollector(legacyAccounts[i], feeDistributor);
		}

		emit AffiliateApproved(affiliate, accountManager);
	}

	function proposeAdminTransfer(address affiliate, address newAdmin) external {
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();
		if (affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();
		if (newAdmin == address(0)) revert ZeroAddress();

		affiliates[affiliate].pendingAdmin = newAdmin;
		emit AdminTransferProposed(affiliate, newAdmin);
	}

	function acceptAdminTransfer(address affiliate) external {
		if (affiliates[affiliate].pendingAdmin != msg.sender) revert Unauthorized();

		address oldAdmin = affiliates[affiliate].admin;
		affiliates[affiliate].admin = msg.sender;
		affiliates[affiliate].pendingAdmin = address(0);

		emit AdminTransferCompleted(affiliate, oldAdmin, msg.sender);
	}

	function cancelAdminTransfer(address affiliate) external {
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();

		affiliates[affiliate].pendingAdmin = address(0);
		emit AdminTransferCancelled(affiliate);
	}

	function updateAffiliateDetails(
		address affiliate,
		string memory name,
		string memory brandColor
	) external onlyAffiliateAdmin(affiliate, msg.sender) onlyIfAffiliateIsActive(affiliate) {
		if (bytes(name).length == 0 || bytes(name).length > 100) revert InvalidNameLength();
		affiliates[affiliate].name = name;
		affiliates[affiliate].brandColor = brandColor;

		emit AffiliateUpdated(affiliate, name, brandColor);
	}

	function requestFeeUpdate(
		address affiliate,
		Stakeholder[] memory newStakeholders,
		uint256 newSymmioShare
	) external onlyAffiliateAdmin(affiliate, msg.sender) onlyIfAffiliateIsActive(affiliate) {
		if (newSymmioShare > 1e18) revert InvalidShare();

		// Validate shares
		uint256 totalShare = newSymmioShare;
		for (uint256 i = 0; i < newStakeholders.length; i++) {
			if (newStakeholders[i].receiver == address(0)) revert ZeroAddress();
			totalShare += newStakeholders[i].share;
		}
		if (totalShare != 1e18) revert SharesMustSumTo100();

		// Store pending update
		delete pendingFeeUpdates[affiliate].stakeholders;
		PendingFeeUpdate storage pending = pendingFeeUpdates[affiliate];
		pending.symmioShare = newSymmioShare;
		pending.timestamp = block.timestamp;
		pending.exists = true;

		for (uint256 i = 0; i < newStakeholders.length; i++) {
			pending.stakeholders.push(newStakeholders[i]);
		}

		emit StakeholdersUpdateRequested(affiliate);
	}

	function getClaimable(address affiliate, address symmio) internal view returns (uint256) {
		address collateral = ISymmio(symmio).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		AffiliateData storage affiliateData = affiliates[affiliate];
		uint256 balance = ISymmio(symmio).balanceOf(affiliateData.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	function claimAllFees(address affiliate, address symmio) external whenNotPaused nonReentrant {
		claimFees(affiliate, symmio, getClaimable(affiliate, symmio));
	}

	function claimFees(address affiliate, address symmio, uint256 amount) public whenNotPaused nonReentrant {
		address collateral = ISymmio(symmio).getCollateral();

		AffiliateData storage affiliateData = affiliates[affiliate];

		Stakeholder[] memory originalStakeholders = affiliateData.feeDetails.stakeholders;
		Stakeholder[] memory stakeholders = new Stakeholder[](originalStakeholders.length + 1);

		// Copy original stakeholders
		for (uint256 i = 0; i < originalStakeholders.length; i++) {
			stakeholders[i] = originalStakeholders[i];
		}

		// Add Symmio stakeholder
		stakeholders[originalStakeholders.length] = Stakeholder({ receiver: symmioFeeReceiver, share: affiliateData.feeDetails.symmioShare });

		uint256 len = stakeholders.length;

		bool auth = false;
		for (uint256 i = 0; i < len; i++) {
			if (getSigner() == stakeholders[i].receiver) {
				auth = true;
				break;
			}
		}

		if (!auth && !hasRole(DISTRIBUTOR_ROLE, getSigner())) revert Unauthorized();

		ISymmio(symmio).setSigner(affiliateData.feeDistributor);
		ISymmio(symmio).withdrawTo(address(this), amount);
		ISymmio(symmio).setSigner(address(0));

		uint256 checkAmount = 0;
		for (uint256 i = 0; i < len; i++) {
			uint256 share = (stakeholders[i].share * amount) / 1e18;
			IERC20Upgradeable(collateral).safeTransfer(stakeholders[i].receiver, share);
			checkAmount += share;
			emit FeesDistributed(stakeholders[i].receiver, share);
		}

		if (checkAmount != amount) revert InvalidAmount();
		emit FeesClaimed(amount);
	}

	function dryClaimAllFees(address affiliate, address symmio) public view returns (address[] memory holders, uint256[] memory shares) {
		uint256 totalClaimable = getClaimable(affiliate, symmio);

		AffiliateData storage affiliateData = affiliates[affiliate];

		Stakeholder[] memory originalStakeholders = affiliateData.feeDetails.stakeholders;
		Stakeholder[] memory stakeholders = new Stakeholder[](originalStakeholders.length + 1);

		// Copy original stakeholders
		for (uint256 i = 0; i < originalStakeholders.length; i++) {
			stakeholders[i] = originalStakeholders[i];
		}

		// Add Symmio stakeholder
		stakeholders[originalStakeholders.length] = Stakeholder({ receiver: symmioFeeReceiver, share: affiliateData.feeDetails.symmioShare });

		uint256 len = stakeholders.length;

		holders = new address[](len);
		shares = new uint256[](len);

		for (uint256 i = 0; i < len; i++) {
			holders[i] = stakeholders[i].receiver;
			shares[i] = (stakeholders[i].share * totalClaimable) / 1e18;
		}

		return (holders, shares);
	}

	function cancelFeeUpdate(address affiliate) external onlyAffiliateAdmin(affiliate, msg.sender) {
		if (!pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();
		delete pendingFeeUpdates[affiliate];
		emit FeeUpdateCancelled(affiliate);
	}

	function approveFeeUpdate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		if (!pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		// Apply the update
		delete affiliates[affiliate].feeDetails.stakeholders;
		affiliates[affiliate].feeDetails.symmioShare = pendingFeeUpdates[affiliate].symmioShare;

		for (uint256 i = 0; i < pendingFeeUpdates[affiliate].stakeholders.length; i++) {
			affiliates[affiliate].feeDetails.stakeholders.push(pendingFeeUpdates[affiliate].stakeholders[i]);
		}

		delete pendingFeeUpdates[affiliate];
		emit StakeholdersUpdated(affiliate);
	}

	function pauseAffiliate(address affiliate) external onlyIfAffiliateIsActive(affiliate) {
		if (!hasRole(PAUSER_ROLE, msg.sender) && affiliates[affiliate].admin != msg.sender) revert Unauthorized();

		affiliates[affiliate].state = AffiliateState.PAUSED;

		emit AffiliatePaused(affiliate, true);
	}

	function unpauseAffiliate(address affiliate) external {
		if (
			!hasRole(UNPAUSER_ROLE, msg.sender) &&
			!(affiliates[affiliate].admin == msg.sender && affiliates[affiliate].state == AffiliateState.PAUSED)
		) revert Unauthorized();
		if (affiliates[affiliate].state != AffiliateState.PAUSED) revert NotPaused();

		affiliates[affiliate].state = AffiliateState.ACTIVE;

		emit AffiliatePaused(affiliate, false);
	}

	function batchCreateSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		if (accountsData.length == 0) revert EmptyArray();

		address[] memory createdAccounts = new address[](accountsData.length);

		address signer = getSigner();
		for (uint256 i = 0; i < accountsData.length; i++) {
			SubAccountCreationData memory data = accountsData[i];

			if (bytes(data.name).length == 0) revert InvalidNameLength();
			if (!availableCores[data.relatedCore]) revert InvalidCore();

			// Generate deterministic address
			uint256 nonce = globalNonce++;
			address subAccountAddress = _generateSubAccountAddress(affiliate, signer, nonce);

			// Store account data
			subAccounts[subAccountAddress] = SubAccountData({
				owner: signer,
				affiliate: affiliate,
				name: data.name,
				metadata: data.metadata,
				exists: true,
				virtualAccountCount: 0,
				relatedCore: data.relatedCore
			});
			userToSubAccounts[signer].add(subAccountAddress);

			// Call hook if set
			_callHook(affiliate, IHooks.onAccountCreation.selector, abi.encode(subAccountAddress, data.metadata));

			emit SubAccountCreated(subAccountAddress, signer, affiliate, data.name);
			emit AddAccount(signer, subAccountAddress, data.name);

			createdAccounts[i] = subAccountAddress;

			if (accountsData[i].initialDeposit > 0) {
				_depositForAccount(createdAccounts[i], accountsData[i].initialDeposit);
			}
		}

		return createdAccounts;
	}

	function createVirtualAccount(
		address parentAccount,
		IsolationType isolationType,
		uint256 symbolId,
		bytes memory metadata
	) private whenNotPaused nonReentrant returns (address virtualAccount) {
		SubAccountData storage parent = subAccounts[parentAccount];
		if (!parent.exists) revert InvalidParent();
		address signer = getSigner();
		if (!_isOwnerOf(parentAccount, signer)) revert NotOwner();

		if (symbolId > 0) {
			if (isolationType != IsolationType.MARKET_LONG && isolationType != IsolationType.MARKET_SHORT) {
				revert InvalidIsolationType();
			}
		} else {
			if (isolationType != IsolationType.POSITION) revert InvalidIsolationType();
		}

		uint256 nonce = globalNonce++;
		virtualAccount = _generateVirtualAccountAddress(parentAccount, nonce);

		virtualAccounts[virtualAccount] = VirtualAccountData({
			parentAccount: parentAccount,
			isDeleted: false,
			isolationType: isolationType,
			symbolId: symbolId,
			quotesCount: 0,
			quoteId: 0,
			createdAt: block.timestamp,
			metadata: metadata
		});
		parent.virtualAccountCount++;
		subAccountToVirtualAccounts[parentAccount].add(virtualAccount);

		_callHook(parent.affiliate, IHooks.onVirtualAccountCreation.selector, abi.encode(virtualAccount, parentAccount));

		emit VirtualAccountCreated(virtualAccount, parentAccount, isolationType);

		return virtualAccount;
	}

	function createVirtualAndSendQuote(
		address parentAccount,
		VirtualAccountCreationData memory creationData,
		bytes calldata quoteData
	) external whenNotPaused nonReentrant returns (address virtualAccount) {
		bytes4 selector = bytes4(quoteData[:4]);
		if (selector != SEND_QUOTE_SELECTOR) revert InvalidFunctionSelector();

		(, uint256 symbolId, ISymmio.PositionType positionType, , , , , , , , , , , ) = abi.decode(
			quoteData[4:],
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

		if (creationData.isolationType != IsolationType.POSITION) {
			if (symbolId != creationData.symbolId) revert InvalidsymbolId();
			IsolationType expectedType = positionType == ISymmio.PositionType.LONG ? IsolationType.MARKET_LONG : IsolationType.MARKET_SHORT;
			if (creationData.isolationType != expectedType | IsolationType.MARKET) revert InvalidIsolationType();
		}

		virtualAccount = createVirtualAccount(parentAccount, creationData.isolationType, creationData.symbolId, creationData.metadata);
		_depositAndAllocateForAccount(virtualAccount, creationData.initialDeposit);

		// Execute sendQuote through the virtual account
		_executeWithSigner(virtualAccount, quoteData);

		if (creationData.isolationType == IsolationType.POSITION) {
			address core = getRelatedCore(virtualAccount);
			uint256 quoteId = ISymmio(core).getNextQuoteId() - 1;
			virtualAccounts[virtualAccount].quoteId = quoteId;
		}

		return virtualAccount;
	}

	function editAccountName(address account, string memory name) external whenNotPaused {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (bytes(name).length == 0) revert InvalidNameLength();
		if (!subAccounts[account].exists) revert AccountDoesNotExist();

		subAccounts[account].name = name;
		emit EditAccountName(signer, account, name);
	}

	function depositForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (amount == 0) revert ZeroAmount();
		_depositForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (amount == 0) revert ZeroAmount();
		_depositAndAllocateForAccount(account, amount);
	}

	function withdrawFromAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (amount == 0) revert ZeroAmount();
		_withdrawFromAccount(account, amount);
	}

	function _depositForAccount(address account, uint256 amount) private {
		address signer = getSigner();
		address collateral = ISymmio(getRelatedCore(account)).getCollateral();
		IERC20Upgradeable(collateral).safeTransferFrom(signer, address(this), amount);
		IERC20Upgradeable(collateral).safeIncreaseAllowance(getRelatedCore(account), amount);

		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.depositFor.selector, account, amount));

		// Hook (if any)
		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onDeposit.selector, abi.encode(account, amount));

		emit DepositForAccount(signer, account, amount);
	}

	function _depositAndAllocateForAccount(address account, uint256 amount) private {
		address signer = getSigner();
		_depositForAccount(account, amount);

		address collateral = ISymmio(getRelatedCore(account)).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		if (decimals > 18) revert InvalidTokenDecimals();

		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** decimals);

		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.allocate.selector, amountWith18Decimals));

		emit AllocateForAccount(signer, account, amountWith18Decimals);
	}

	function _withdrawFromAccount(address account, uint256 amount) private {
		address signer = getSigner();
		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.withdrawTo.selector, signer, amount));

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onWithdraw.selector, abi.encode(account, amount));

		emit WithdrawFromAccount(signer, account, amount);
	}

	function _call(address account, bytes[] memory callDatas) external whenNotPaused nonReentrant {
		address signer = getSigner();
		if (!_isOwnerOf(account, signer)) revert NotOwner();
		if (callDatas.length == 0) revert EmptyArray();

		for (uint256 i = 0; i < callDatas.length; i++) {
			_executeWithSigner(account, callDatas[i]);
		}

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onCall.selector, abi.encode(account, callDatas));
	}
	
	function setHook(address affiliate, bytes4 selector, address hook) external {
		if (affiliates[affiliate].state != AffiliateState.ACTIVE) revert AffiliateNotActive();
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();

		affiliates[affiliate].hooks[selector] = hook;
		emit HookSet(affiliate, selector, hook);
	}

	function removeHook(address affiliate, bytes4 selector) external {
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();

		delete affiliates[affiliate].hooks[selector];
		emit HookRemoved(affiliate, selector);
	}

	function _deployAccountManager(address affiliate) internal returns (address) {
		bytes32 salt = keccak256(abi.encodePacked("AccountManager", affiliate));
		bytes memory bytecode = abi.encodePacked(accountManagerImplementation);

		address accountManager;

		assembly {
			accountManager := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
		}

		if (accountManager == address(0)) revert DeploymentFailed();

		// Initialize the account manager
		IAccountManager(accountManager).initialize(address(this));

		return accountManager;
	}

	function _generateAccountManagerAddress(string memory name) internal view returns (address) {
		bytes32 salt = keccak256(abi.encodePacked("AccountManager", name));
		bytes32 initCodeHash = keccak256(abi.encodePacked(accountManagerImplementation));

		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
	}

	function _generateSubAccountAddress(address affiliate, address user, uint256 nonce) internal pure returns (address) {
		return
			address(
				uint160(
					uint256(keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(user, nonce)), ACCOUNT_INIT_CODE_HASH)))
				)
			);
	}

	function _generateFeeDistributorAddress(address affiliate, uint256 nonce) internal pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(nonce)), VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH))
					)
				)
			);
	}

	function _generateVirtualAccountAddress(address parentAccount, uint256 nonce) internal pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(
							abi.encodePacked(
								bytes1(0xff),
								parentAccount,
								keccak256(abi.encodePacked("VIRTUAL", nonce)),
								VIRTUAL_ACCOUNT_INIT_CODE_HASH
							)
						)
					)
				)
			);
	}

	function _executeWithSigner(address account, bytes memory callData) internal {
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

	function getRelatedCore(address account) public view returns (address) {
		if (subAccounts[account].exists) {
			return subAccounts[account].relatedCore;
		}

		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return getRelatedCore(parent);
		}

		uint256 len = legacyMultiAccounts.length();
		for (uint256 i = 0; i < len; i++) {
			address owner = IMultiAccount(legacyMultiAccounts.at(i)).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyMultiAccounts.at(i)).symmioAddress();
			}
		}

		revert UnableToRetrieveCore();
	}

	function _isOwnerOf(address account, address user) internal view returns (bool) {
		// Check sub-account first (most common case)
		if (subAccounts[account].owner == user) {
			return true;
		}

		// Check if it's a virtual account (recursive check)
		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return _isOwnerOf(parent, user);
		}

		// Check legacy multi-account ownerships
		uint256 len = legacyMultiAccounts.length();
		for (uint256 i = 0; i < len; i++) {
			address owner = IMultiAccount(legacyMultiAccounts.at(i)).owners(account);
			if (owner == user) {
				return true;
			}
		}

		return false;
	}

	function _getAffiliateForAccount(address account) internal view returns (address) {
		if (subAccounts[account].exists) {
			return subAccounts[account].affiliate;
		}

		if (virtualAccounts[account].parentAccount != address(0)) {
			return _getAffiliateForAccount(virtualAccounts[account].parentAccount);
		}

		return address(0);
	}

	function _deleteVirtualAccount(address account) internal {
		VirtualAccountData storage vData = virtualAccounts[account];
		if (vData.isDeleted) revert AlreadyDeleted();
		if (getOpenPositionCount(account) != 0) revert OpenPositionsExist();

		address parentAccount = vData.parentAccount;
		address core = getRelatedCore(parentAccount);
		address collateral = ISymmio(core).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		if (decimals > 18) revert InvalidTokenDecimals();

		// Deallocate all funds before deletion
		uint256 allocatedBalance = ISymmio(core).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			// Use the 18-decimal balance directly for deallocation
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.deallocate.selector, allocatedBalance));
		}

		// Transfer remaining balance to parent
		uint256 balance = ISymmio(core).balanceOf(account);
		if (balance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parentAccount, balance));
		}

		// Mark as deleted (keep data for trackers)
		vData.isDeleted = true;
		subAccounts[parentAccount].virtualAccountCount--;

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onVirtualAccountDeletion.selector, abi.encode(account));

		emit VirtualAccountDeleted(account, parentAccount);
	}

	function onClosePosition(
		uint256 quoteId,
		uint256 _filledAmount,
		uint256 _closedPrice,
		address partyA,
		address _partyB
	) external onlySymmio nonReentrant whenNotPaused {
		VirtualAccountData storage vData = virtualAccounts[partyA];
		if (vData.parentAccount == address(0)) revert NotVirtualAccount();
		if (vData.isDeleted) revert AccountDeleted();
		if (getOpenPositionCount(partyA) == 0) {
			_deleteVirtualAccount(partyA);
		}
	}

	function _callHook(address affiliate, bytes4 selector, bytes memory data) internal {
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

	function setSymmioFeeReceiver(address receiver) external onlyRole(SETTER_ROLE) {
		if (receiver == address(0)) revert ZeroAddress();
		address oldReceiver = symmioFeeReceiver;
		symmioFeeReceiver = receiver;
		emit SymmioFeeReceiverUpdated(oldReceiver, receiver);
	}

	function setAccountManagerImplementation(bytes memory implementation) external onlyRole(SETTER_ROLE) {
		if (implementation.length == 0) revert EmptyArray();
		accountManagerImplementation = implementation;
	}

	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	function setSigner(address _signer) external onlyRole(SIGNER_SETTER) {
		globalSigner = _signer;
	}

	function getSigner() public view returns (address) {
		return globalSigner == address(0) ? msg.sender : globalSigner;
	}

	function setAvailableCore(address core, bool status) external onlyRole(SETTER_ROLE) {
		availableCores[core] = status;
		emit AvailableCoreSet(core, status);
	}

	// ==================== View Functions ====================

	function getAffiliateDetails(
		address affiliate
	)
		external
		view
		returns (string memory name, string memory brandColor, address admin, address accountManager, AffiliateState state, uint256 symmioShare)
	{
		AffiliateData storage f = affiliates[affiliate];
		return (f.name, f.brandColor, f.admin, f.accountManager, f.state, f.feeDetails.symmioShare);
	}

	function getAffiliateStakeholders(address affiliate) external view returns (Stakeholder[] memory) {
		return affiliates[affiliate].feeDetails.stakeholders;
	}

	function getOpenPositionCount(address account) internal view returns (uint256) {
		return ISymmio(getRelatedCore(account)).getPartyAOpenPositions(account, 0, MAX_POSITION_QUERY_LIMIT).length;
	}

	function getSubAccounts(address owner) external view returns (address[] memory) {
		return userToSubAccounts[owner].values();
	}

	function getVirtualAccounts(address subAccount) external view returns (address[] memory) {
		return subAccountToVirtualAccounts[subAccount].values();
	}

	function getAllAffiliates() external view returns (address[] memory) {
		return affiliateAddresses.values();
	}

	function getAffiliateCount() external view returns (uint256) {
		return affiliateAddresses.length();
	}
}
