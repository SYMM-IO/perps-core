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

import "./interfaces/IAccountHub.sol";
import "./interfaces/ISymmio.sol";
import "./interfaces/IAccountManager.sol";
import "./interfaces/IHook.sol";
import "./interfaces/IMultiAccount.sol";

contract AccountsHub is IAccountHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;

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
	mapping(address => PendingFeeUpdate) public pendingFeeUpdates;

	// Account related storage
	mapping(address => SubAccountData) public subAccounts;
	mapping(address => VirtualAccountData) public virtualAccounts;
	mapping(address => address[]) accountToSubAccounts;
	mapping(address => address[]) subAccountToVirtualAccounts;
	mapping(address => mapping(address => uint256)) public userAccountNonce;

	// Legacy support
	address[] legacyMultiAccounts;

	// Hook system: Affiliate => selector => hook contract
	mapping(address => mapping(bytes4 => address)) public affiliateHooks;

	// For backward compatibility - maintain old structure
	mapping(address => Account[]) public legacyAccounts;
	mapping(address => uint256) public legacyIndexOfAccount;
	mapping(address => address) public legacyOwners;

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACCOUNT_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VIRTUAL_ACCOUNT_V1");
	bytes32 private constant VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH = keccak256("VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH_V1");

	address signer;

	modifier isAffiliateAdmin(address affiliate, address admin) {
		require(affiliates[affiliate].admin == admin, "AccountsHub: Not admin");
		_;
	}

	modifier isAffiliateActive(address affiliate) {
		require(affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountsHub: Affiliate not active");
		_;
	}

	modifier isSymmio() {
		require(availableCores[msg.sender], "AccountsHub: Not Symmio core");
		_;
	}

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(
		address _admin,
		address _symmioFeeReceiver,
		bytes memory _accountManagerImplementation
	) public initializer {
		require(_admin != address(0), "AccountsHub: Zero admin");
		require(_symmioFeeReceiver != address(0), "AccountsHub: Zero fee receiver");
		require(_accountManagerImplementation.length > 0, "AccountsHub: Zero implementation");

		__Pausable_init();
		__AccessControl_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);

		symmioFeeReceiver = _symmioFeeReceiver;
		accountManagerImplementation = _accountManagerImplementation;
	}

	function registerAffiliate(AffiliateRegistration memory reg) external whenNotPaused {
		AffiliateState currentState = affiliates[msg.sender].state;
		require(currentState == AffiliateState.NONE, "AccountsHub: Already registered or pending");
		require(reg.admin != address(0), "AccountsHub: Zero admin");
		require(bytes(reg.name).length > 0 && bytes(reg.name).length <= 100, "AccountsHub: Invalid name length");
		require(reg.symmioShare <= 1e18, "AccountsHub: Invalid Symmio share");

		uint256 totalShare = reg.symmioShare;
		for (uint256 i = 0; i < reg.stakeholders.length; i++) {
			require(reg.stakeholders[i].receiver != address(0), "AccountsHub: Zero stakeholder");
			totalShare += reg.stakeholders[i].share;
		}
		require(totalShare == 1e18, "AccountsHub: Shares must sum to 100%");

		AffiliateData storage affiliate = affiliates[msg.sender];
		affiliate.name = reg.name;
		affiliate.brandColor = reg.brandColor;
		affiliate.admin = reg.admin;
		affiliate.state = AffiliateState.PENDING;
		affiliate.symmioShare = reg.symmioShare;
		affiliate.metadata = reg.metadata;
		affiliate.stakeholders = reg.stakeholders;
		affiliate.legacyMultiAccounts = reg.legacyMultiAccounts;

		emit AffiliateRegistered(msg.sender, reg.name);
	}

	function cancelRegistration(address affiliate) external isAffiliateAdmin(affiliate, msg.sender) {
		require(affiliates[affiliate].state == AffiliateState.PENDING, "AccountsHub: Not pending");
		delete affiliates[affiliate];
		emit RegistrationCancelled(affiliate);
	}

	function approveAffiliate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		require(affiliates[affiliate].state == AffiliateState.PENDING, "AccountsHub: Not pending");

		// Deploy Account Manager for this affiliate
		address accountManager = _deployAccountManager(affiliate);
		address feeDistributor = _generateFeeDistributorAddress(affiliate, 0); // TODO ::: incremental or random nonce
		grantRole(SIGNER_SETTER, accountManager);
		// ISymmio(symmioAddress).setFeeCollector(affiliate, feeDistributor); // TODO ::: better to remove it, set fee collector manually cause of different interfaces in cores

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		affiliates[affiliate].accountManager = accountManager;
		affiliates[affiliate].feeDistributor = feeDistributor;

		address[] memory legacyAccounts = affiliates[affiliate].legacyMultiAccounts;
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			legacyMultiAccounts.push(legacyAccounts[i]);
		}

		emit AffiliateApproved(affiliate, accountManager);
	}

	function updateAffiliateDetails(
		address affiliate,
		string memory name,
		string memory brandColor
	) external isAffiliateAdmin(affiliate, msg.sender) isAffiliateActive(affiliate) {
		require(bytes(name).length > 0 && bytes(name).length <= 100, "AccountsHub: Invalid name length");
		affiliates[affiliate].name = name;
		affiliates[affiliate].brandColor = brandColor;

		emit AffiliateUpdated(affiliate, name, brandColor);
	}

	function requestFeeUpdate(
		address affiliate,
		Stakeholder[] memory newStakeholders,
		uint256 newSymmioShare
	) external isAffiliateAdmin(affiliate, msg.sender) isAffiliateActive(affiliate) {
		require(newSymmioShare <= 1e18, "AccountsHub: Invalid Symmio share");

		// Validate shares
		uint256 totalShare = newSymmioShare;
		for (uint256 i = 0; i < newStakeholders.length; i++) {
			require(newStakeholders[i].receiver != address(0), "AccountsHub: Zero stakeholder");
			totalShare += newStakeholders[i].share;
		}
		require(totalShare == 1e18, "AccountsHub: Shares must sum to 100%");

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

	function getClaimable(address affiliate) internal view returns (uint256) {
		address collateral = ISymmio(symmioAddress).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		AffiliateData memory affiliateData = affiliates[affiliate];
		uint256 balance = ISymmio(symmioAddress).balanceOf(affiliateData.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	function claimAllFees(address affiliate) external whenNotPaused nonReentrant {
		claimFees(affiliate, getClaimable(affiliate));
	}

	function claimFees(address affiliate, uint256 amount) public whenNotPaused nonReentrant {
		address collateral = ISymmio(symmioAddress).getCollateral();

		AffiliateData memory affiliateData = affiliates[affiliate];

		Stakeholder[] memory originalStakeholders = affiliateData.stakeholders;
		Stakeholder[] memory stakeholders = new Stakeholder[](originalStakeholders.length + 1);

		// Copy original stakeholders
		for (uint256 i = 0; i < originalStakeholders.length; i++) {
			stakeholders[i] = originalStakeholders[i];
		}

		// Add Symmio stakeholder
		stakeholders[originalStakeholders.length] = Stakeholder({ receiver: symmioFeeReceiver, share: affiliateData.symmioShare });

		uint256 len = stakeholders.length;

		bool auth = false;
		for (uint256 i = 0; i < len; i++) {
			if (getSigner() == stakeholders[i].receiver) {
				auth = true;
				break;
			}
		}

		require(auth || hasRole(DISTRIBUTOR_ROLE, getSigner()), "AccountHub: unAuth to execute this method");

		ISymmio(symmioAddress).setSigner(affiliateData.feeDistributor);
		ISymmio(symmioAddress).withdrawTo(address(this), amount);
		ISymmio(symmioAddress).setSigner(address(0));

		uint256 checkAmount = 0;
		for (uint256 i = 0; i < len; i++) {
			uint256 share = (stakeholders[i].share * amount) / 1e18;
			IERC20Upgradeable(collateral).safeTransfer(stakeholders[i].receiver, share);
			checkAmount += share;
			emit FeesDistributed(stakeholders[i].receiver, share);
		}

		require(checkAmount == amount, "AccountHub: wrong amount distributed");
		emit FeesClaimed(amount);
	}

	function dryClaimAllFees(address affiliate) public view returns (address[] memory holders, uint256[] memory shares) {
		uint256 totalClaimable = getClaimable(affiliate);

		AffiliateData memory affiliateData = affiliates[affiliate];

		Stakeholder[] memory originalStakeholders = affiliateData.stakeholders;
		Stakeholder[] memory stakeholders = new Stakeholder[](originalStakeholders.length + 1);

		// Copy original stakeholders
		for (uint256 i = 0; i < originalStakeholders.length; i++) {
			stakeholders[i] = originalStakeholders[i];
		}

		// Add Symmio stakeholder
		stakeholders[originalStakeholders.length] = Stakeholder({ receiver: symmioFeeReceiver, share: affiliateData.symmioShare });

		uint256 len = stakeholders.length;

		holders = new address[](len);
		shares = new uint256[](len);

		for (uint256 i = 0; i < len; i++) {
			holders[i] = stakeholders[i].receiver;
			shares[i] = (stakeholders[i].share * totalClaimable) / 1e18;
		}

		return (holders, shares);
	}

	function cancelFeeUpdate(address affiliate) external isAffiliateAdmin(affiliate, msg.sender) {
		require(pendingFeeUpdates[affiliate].exists, "AccountsHub: No pending update");
		delete pendingFeeUpdates[affiliate];
		emit FeeUpdateCancelled(affiliate);
	}

	function approveFeeUpdate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		require(pendingFeeUpdates[affiliate].exists, "AccountsHub: No pending update");

		// Apply the update
		delete affiliates[affiliate].stakeholders;
		affiliates[affiliate].symmioShare = pendingFeeUpdates[affiliate].symmioShare;

		for (uint256 i = 0; i < pendingFeeUpdates[affiliate].stakeholders.length; i++) {
			affiliates[affiliate].stakeholders.push(pendingFeeUpdates[affiliate].stakeholders[i]);
		}

		delete pendingFeeUpdates[affiliate];
		emit StakeholdersUpdated(affiliate);
	}

	function pauseAffiliate(address affiliate) external isAffiliateActive(affiliate) {
		require(hasRole(PAUSER_ROLE, msg.sender) || affiliates[affiliate].admin == msg.sender, "AccountsHub: Unauthorized");

		affiliates[affiliate].state = AffiliateState.PAUSED;

		emit AffiliatePaused(affiliate, true);
	}

	function unpauseAffiliate(address affiliate) external {
		require(
			hasRole(UNPAUSER_ROLE, msg.sender) || (affiliates[affiliate].admin == msg.sender && affiliates[affiliate].state == AffiliateState.PAUSED),
			"AccountsHub: Unauthorized"
		);
		require(affiliates[affiliate].state == AffiliateState.PAUSED, "AccountsHub: Not paused");

		affiliates[affiliate].state = AffiliateState.ACTIVE;

		emit AffiliatePaused(affiliate, false);
	}

	function createSubAccount(
		address affiliate,
		string memory name,
		address relatedCore,
		bytes memory metadata
	) public isAffiliateActive(affiliate) whenNotPaused nonReentrant returns (address account) {
		require(bytes(name).length > 0, "AccountsHub: Empty name");
		require(availableCores[relatedCore], "AccountHub: wrong core");
		address signer = getSigner();

		// Generate deterministic address
		uint256 nonce = userAccountNonce[signer][affiliate]++;
		account = _generateSubAccountAddress(affiliate, signer, nonce);

		// Store account data
		subAccounts[account] = SubAccountData({
			owner: signer,
			affiliate: affiliate,
			name: name,
			metadata: metadata,
			exists: true,
			virtualAccountCount: 0,
			relatedCore: relatedCore,
			nonce: 0
		});
		accountToSubAccounts[signer].push(account);

		// Update backward compatibility mappings
		legacyOwners[account] = signer;
		legacyIndexOfAccount[account] = legacyAccounts[signer].length;
		legacyAccounts[signer].push(Account(account, name));

		// Call hook if set
		_callHook(affiliate, IHooks.onAccountCreation.selector, abi.encode(account, metadata));

		emit SubAccountCreated(account, signer, affiliate, name);
		emit AddAccount(signer, account, name);

		return account;
	}

	function batchCreateSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		require(accountsData.length > 0, "AccountsHub: Empty array");

		address[] memory createdAccounts = new address[](accountsData.length);

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = createSubAccount(affiliate, accountsData[i].name, accountsData[i].relatedCore, accountsData[i].metadata);

			if (accountsData[i].initialDeposit > 0) {
				_depositForAccount(createdAccounts[i], accountsData[i].initialDeposit);
			}
		}

		return createdAccounts;
	}

	function createVirtualAccount(
		address parentAccount,
		IsolationType isolationType,
		uint256 marketId,
		bytes memory metadata
	) private whenNotPaused nonReentrant returns (address virtualAccount) {
		SubAccountData storage parent = subAccounts[parentAccount];
		require(parent.exists, "AccountsHub: Invalid parent");
		address signer = getSigner();
		require(_isOwnerOf(parentAccount, signer), "AccountsHub: Not owner");

		if (marketId > 0) {
			require(
				isolationType == IsolationType.MARKET_LONG || isolationType == IsolationType.MARKET_SHORT,
				"AccountsHub: Expected MARKET_LONG or MARKET_SHORT isolation"
			);
		} else {
			require(isolationType == IsolationType.POSITION, "AccountsHub: Expected POSITION isolation");
		}

		uint256 nonce = parent.nonce++;
		virtualAccount = _generateVirtualAccountAddress(parentAccount, nonce);

		virtualAccounts[virtualAccount] = VirtualAccountData({
			parentAccount: parentAccount,
			isDeleted: false,
			isolationType: isolationType,
			marketId: marketId,
			createdAt: block.timestamp,
			metadata: metadata
		});

		parent.virtualAccountCount++;
		subAccountToVirtualAccounts[parentAccount].push(virtualAccount);
		legacyOwners[virtualAccount] = parentAccount;

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
		require(selector == SEND_QUOTE_SELECTOR, "AccountsHub: Invalid function selector");

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
			require(symbolId == creationData.marketId, "AccountsHub: Invalid marketId");

			// Match isolation type to position type
			IsolationType expectedType = positionType == ISymmio.PositionType.LONG ? IsolationType.MARKET_LONG : IsolationType.MARKET_SHORT;

			require(creationData.isolationType == expectedType, "AccountsHub: Invalid isolation type");
		}

		virtualAccount = createVirtualAccount(parentAccount, creationData.isolationType, creationData.marketId, creationData.metadata);
		_depositAndAllocateForAccount(virtualAccount, creationData.initialDeposit);

		// Execute sendQuote through the virtual account
		_executeWithSigner(virtualAccount, quoteData);

		return virtualAccount;
	}

	function editAccountName(address account, string memory name) external whenNotPaused {
		address signer = getSigner();
		require(_isOwnerOf(account, signer), "AccountsHub: Not owner");
		require(bytes(name).length > 0, "AccountsHub: Empty name");

		if (subAccounts[account].exists) {
			subAccounts[account].name = name;
		}

		// Update in legacy array too
		uint256 index = legacyIndexOfAccount[account];
		if (index < legacyAccounts[signer].length) {
			legacyAccounts[signer][index].name = name;
		}

		emit EditAccountName(signer, account, name);
	}

	function depositForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		address signer = getSigner();
		require(_isOwnerOf(account, signer), "AccountsHub: Not owner"); // TODO ::: needed? anyone can deposit for any other oen.
		require(amount > 0, "AccountsHub: Zero amount");
		_depositForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		address signer = getSigner();
		require(_isOwnerOf(account, signer), "AccountsHub: Not owner");
		require(amount > 0, "AccountsHub: Zero amount");
		_depositAndAllocateForAccount(account, amount);
	}

	function withdrawFromAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		address signer = getSigner();
		require(_isOwnerOf(account, signer), "AccountsHub: Not owner");
		require(amount > 0, "AccountsHub: Zero amount");
		_withdrawFromAccount(account, amount);
	}

	function _depositForAccount(address account, uint256 amount) private {
		address signer = getSigner();
		address collateral = ISymmio(getRelatedCore(signer)).getCollateral();
		IERC20Upgradeable(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20Upgradeable(collateral).safeIncreaseAllowance(symmioAddress, amount);

		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.depositFor.selector, account, amount));

		// Hook (if any)
		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onDeposit.selector, abi.encode(account, amount));

		emit DepositForAccount(signer, account, amount);
	}

	function _depositAndAllocateForAccount(address account, uint256 amount) private {
		address signer = getSigner();
		_depositForAccount(account, amount);

		address collateral = ISymmio(getRelatedCore(signer)).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		require(decimals <= 18, "AccountsHub: Invalid token decimals");

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
		require(_isOwnerOf(account, signer), "AccountsHub: Not owner");
		require(callDatas.length > 0, "AccountsHub: Empty array");

		for (uint256 i = 0; i < callDatas.length; i++) {
			_executeWithSigner(account, callDatas[i]);
		}
	}

	function setHook(bytes4 selector, address hook) external {
		require(affiliates[msg.sender].state == AffiliateState.ACTIVE, "AccountsHub: Not active");
		require(affiliates[msg.sender].admin == msg.sender, "AccountsHub: Not admin");

		affiliateHooks[msg.sender][selector] = hook;
		emit HookSet(msg.sender, selector, hook);
	}

	function removeHook(bytes4 selector) external {
		require(affiliates[msg.sender].admin == msg.sender, "AccountsHub: Not admin");

		delete affiliateHooks[msg.sender][selector];
		emit HookRemoved(msg.sender, selector);
	}

	function _deployAccountManager(address affiliate) internal returns (address) {
		bytes32 salt = keccak256(abi.encodePacked("AccountManager", affiliate));
		bytes memory bytecode = abi.encodePacked(accountManagerImplementation);

		address accountManager;

		assembly {
			accountManager := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
		}

		require(accountManager != address(0), "AccountsHub: Deployment failed");

		// Initialize the account manager
		IAccountManager(accountManager).initialize(address(this), affiliate, symmioAddress);

		return accountManager;
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

	function getRelatedCore(address account) view returns (address) {
		if (subAccounts[account].exists) {
			return subAccounts[account].relatedCore;
		}

		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return getRelatedCore(parent);
		}

		uint256 len = legacyMultiAccounts.length;
		for (uint256 i = 0; i < len; i++) {
			address owner = IMultiAccount(legacyMultiAccounts[i]).owners(account);
			if (owner != address(0)) {
				return IMultiAccount(legacyMultiAccounts[i]).symmioAddress();
			}
		}

		revert("AccountHub: unable to retrieve related core address");
	}

	function _isOwnerOf(address account, address user) internal view returns (bool) {
		// Check sub-account first (most common case)
		if (subAccounts[account].owner == user) {
			return true;
		}

		// Check direct legacy ownership
		if (legacyOwners[account] == user) {
			return true;
		}

		// Check if it's a virtual account (recursive check)
		address parent = virtualAccounts[account].parentAccount;
		if (parent != address(0)) {
			return _isOwnerOf(parent, user);
		}

		// Check legacy multi-account ownerships
		uint256 len = legacyMultiAccounts.length;
		for (uint256 i = 0; i < len; i++) {
			address owner = IMultiAccount(legacyMultiAccounts[i]).owners(account);
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
		require(!vData.isDeleted, "AccountsHub: Already deleted");
		require(getOpenPositionCount(account) == 0, "AccountsHub: Open positions exist");

		address parentAccount = vData.parentAccount;
		address core = getRelatedCore(parentAccount);
		address collateral = ISymmio(core).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		require(decimals <= 18, "AccountsHub: Invalid token decimals");

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
	) external isSymmio nonReentrant whenNotPaused {
		VirtualAccountData storage vData = virtualAccounts[partyA];
		require(vData.parentAccount != address(0), "AccountsHub: Not a virtual account");
		require(!vData.isDeleted, "AccountsHub: Account deleted");
		if (getOpenPositionCount(partyA) == 0) {
			_deleteVirtualAccount(partyA);
		}
	}

	function _callHook(address affiliate, bytes4 selector, bytes memory data) internal {
		address hook = affiliateHooks[affiliate][selector];
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
		require(receiver != address(0), "AccountsHub: Zero address");
		address oldReceiver = symmioFeeReceiver;
		symmioFeeReceiver = receiver;
		emit SymmioFeeReceiverUpdated(oldReceiver, receiver);
	}

	function setSymmioAddress(address _symmioAddress) external onlyRole(SETTER_ROLE) {
		require(_symmioAddress != address(0), "AccountsHub: Zero address");
		symmioAddress = _symmioAddress;
		emit SymmioAddressSet(_symmioAddress);
	}

	function setAccountManagerImplementation(bytes memory implementation) external onlyRole(SETTER_ROLE) {
		require(implementation.length > 0, "AccountsHub: Zero address");
		accountManagerImplementation = implementation;
	}

	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	function setSigner(address _signer) external onlyRole(SIGNER_SETTER) {
		signer = _signer;
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
		return (f.name, f.brandColor, f.admin, f.accountManager, f.state, f.symmioShare);
	}

	function getAffiliateStakeholders(address affiliate) external view returns (Stakeholder[] memory) {
		return affiliates[affiliate].stakeholders;
	}

	function getSigner() public view returns (address) {
		return signer == address(0) ? msg.sender : signer;
	}

	function getOpenPositionCount(address account) internal view returns (uint256) {
		return ISymmio(getRelatedCore(account)).getPartyAOpenPositions(account, 0, MAX_POSITION_QUERY_LIMIT).length;
	}
}
