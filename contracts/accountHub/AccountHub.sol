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

// TODO ::: Fee distribution
// TODO ::: accountManager logics(e.g. delegateAccesses, etc)?

contract AccountsHub is IAccountHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;

	// ==================== Constants ====================
	bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	
	// ==================== Storage ====================
	address public symmioAddress;
	address public symmioFeeReceiver;
	bytes public accountManagerImplementation;

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

	modifier isAffiliateAdmin(address affiliate, address admin) {
		require(affiliates[affiliate].admin == admin, "AccountsHub: Not admin");
		_;
	}

	modifier isAffiliateActive(address affiliate) {
		require(affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountsHub: Affiliate not active");
		_;
	}

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(
		address _admin,
		address _symmioAddress,
		address _symmioFeeReceiver,
		bytes memory _accountManagerImplementation
	) public initializer {
		require(_admin != address(0), "AccountsHub: Zero admin");
		require(_symmioAddress != address(0), "AccountsHub: Zero symmio");
		require(_symmioFeeReceiver != address(0), "AccountsHub: Zero fee receiver");
		require(_accountManagerImplementation.length > 0, "AccountsHub: Zero implementation");

		__Pausable_init();
		__AccessControl_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(APPROVER_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(PAUSER_ROLE, _admin);
		_grantRole(UNPAUSER_ROLE, _admin);

		symmioAddress = _symmioAddress;
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

	function approveAffiliate(address affiliate) external onlyRole(APPROVER_ROLE) {
		require(affiliates[affiliate].state == AffiliateState.PENDING, "AccountsHub: Not pending");

		// Deploy Account Manager for this affiliate
		address accountManager = _deployAccountManager(affiliate);

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		affiliates[affiliate].accountManager = accountManager;

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
	) external isAffiliateAdmin(affiliate, msg.sender) {
		require(affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountsHub: Not active");

		affiliates[affiliate].name = name;
		affiliates[affiliate].brandColor = brandColor;

		emit AffiliateUpdated(affiliate, name, brandColor);
	}

	function requestFeeUpdate(
		address affiliate,
		Stakeholder[] memory newStakeholders,
		uint256 newSymmioShare
	) external isAffiliateAdmin(affiliate, msg.sender) {
		require(affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountsHub: Not active");
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

	function cancelFeeUpdate(address affiliate) external isAffiliateAdmin(affiliate, msg.sender) {
		require(pendingFeeUpdates[affiliate].exists, "AccountsHub: No pending update");
		delete pendingFeeUpdates[affiliate];
		emit FeeUpdateCancelled(affiliate);
	}

	function approveFeeUpdate(address affiliate) external onlyRole(APPROVER_ROLE) {
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

	function pauseAffiliate(address affiliate) external {
		require(
			hasRole(PAUSER_ROLE, msg.sender) || (affiliates[affiliate].admin == msg.sender && affiliates[affiliate].state == AffiliateState.ACTIVE),
			"AccountsHub: Unauthorized"
		);
		require(affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountsHub: Not active");

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
		bytes memory metadata
	) public isAffiliateActive(affiliate) whenNotPaused nonReentrant returns (address account) {
		require(bytes(name).length > 0, "AccountsHub: Empty name");
		
		// Generate deterministic address
		uint256 nonce = userAccountNonce[msg.sender][affiliate]++;
		account = _generateSubAccountAddress(affiliate, msg.sender, nonce);

		// Store account data
		subAccounts[account] = SubAccountData({
			owner: msg.sender,
			affiliate: affiliate,
			name: name,
			metadata: metadata,
			exists: true,
			virtualAccountCount: 0,
			nonce: 0
		});
		accountToSubAccounts[msg.sender].push(account);

		// Update backward compatibility mappings
		legacyOwners[account] = msg.sender;
		legacyIndexOfAccount[account] = legacyAccounts[msg.sender].length;
		legacyAccounts[msg.sender].push(Account(account, name));

		// Call hook if set
		_callHook(affiliate, IHooks.onAccountCreation.selector, abi.encode(account, metadata));

		emit SubAccountCreated(account, msg.sender, affiliate, name);
		emit AddAccount(msg.sender, account, name);

		return account;
	}

	function batchCreateSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		require(accountsData.length > 0, "AccountsHub: Empty array");

		address[] memory createdAccounts = new address[](accountsData.length);

		for (uint256 i = 0; i < accountsData.length; i++) {
			createdAccounts[i] = createSubAccount(affiliate, accountsData[i].name, accountsData[i].metadata);

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
		require(_isOwnerOf(parentAccount, msg.sender), "AccountsHub: Not owner");

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
			openPositionCount: 0,
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
		ISymmio.Quote memory quote = abi.decode(quoteData, (ISymmio.Quote));

		if (creationData.isolationType != IsolationType.POSITION) {
			require(quote.symbolId == creationData.marketId, "AccountsHub: Invalid marketId");

			// Match isolation type to position type
			IsolationType expectedType = quote.positionType == ISymmio.PositionType.LONG ? IsolationType.MARKET_LONG : IsolationType.MARKET_SHORT;

			require(creationData.isolationType == expectedType, "AccountsHub: Invalid isolation type");
		}

		virtualAccount = createVirtualAccount(parentAccount, creationData.isolationType, creationData.marketId, creationData.metadata);
		_depositAndAllocateForAccount(virtualAccount, creationData.initialDeposit);

		// Execute sendQuote through the virtual account
		_executeWithSigner(virtualAccount, quoteData);

		virtualAccounts[virtualAccount].openPositionCount += 1;

		return virtualAccount;
	}

	function editAccountName(address account, string memory name) external whenNotPaused {
		require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
		require(bytes(name).length > 0, "AccountsHub: Empty name");

		if (subAccounts[account].exists) {
			subAccounts[account].name = name;
		}

		// Update in legacy array too
		uint256 index = legacyIndexOfAccount[account];
		if (index < legacyAccounts[msg.sender].length) {
			legacyAccounts[msg.sender][index].name = name;
		}

		emit EditAccountName(msg.sender, account, name);
	}

	function depositForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
		require(amount > 0, "AccountsHub: Zero amount");
		_depositForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
		require(amount > 0, "AccountsHub: Zero amount");
		_depositAndAllocateForAccount(account, amount);
	}

	function withdrawFromAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
		require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
		require(amount > 0, "AccountsHub: Zero amount");
		_withdrawFromAccount(account, amount);
	}

	function _depositForAccount(address account, uint256 amount) private {
		address collateral = ISymmio(symmioAddress).getCollateral();
		IERC20Upgradeable(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20Upgradeable(collateral).safeIncreaseAllowance(symmioAddress, amount);

		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.depositFor.selector, account, amount));

		// Hook (if any)
		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onDeposit.selector, abi.encode(account, amount));

		emit DepositForAccount(msg.sender, account, amount);
	}

	function _depositAndAllocateForAccount(address account, uint256 amount) private {
		_depositForAccount(account, amount);

		address collateral = ISymmio(symmioAddress).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		require(decimals <= 18, "AccountsHub: Invalid token decimals");
		
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** decimals);

		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.allocate.selector, amountWith18Decimals));

		emit AllocateForAccount(msg.sender, account, amountWith18Decimals);
	}

	function _withdrawFromAccount(address account, uint256 amount) private {
		_executeWithSigner(account, abi.encodeWithSelector(ISymmio.withdrawTo.selector, msg.sender, amount));

		address affiliate = _getAffiliateForAccount(account);
		_callHook(affiliate, IHooks.onWithdraw.selector, abi.encode(account, amount));

		emit WithdrawFromAccount(msg.sender, account, amount);
	}

	function _call(address account, bytes[] memory callDatas) external whenNotPaused nonReentrant {
		require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
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
		IAccountManager(accountManager).initialize(address(this), affiliate);

		return accountManager;
	}

	function _generateSubAccountAddress(address affiliate, address user, uint256 nonce) internal pure returns (address) {
		return
			address(
				uint160(
					uint256(
						keccak256(
							abi.encodePacked(
								bytes1(0xff),
								affiliate,
								keccak256(abi.encodePacked(user, nonce)),
								ACCOUNT_INIT_CODE_HASH
							)
						)
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
		ISymmio(symmioAddress).setSigner(account);
		(bool success, bytes memory result) = symmioAddress.call(callData);
		ISymmio(symmioAddress).setSigner(address(0)); // Always reset

		if (!success) {
			assembly {
				revert(add(result, 32), mload(result))
			}
		}

		emit Call(msg.sender, account, callData, true, result);
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

		// Check legacy multi-account ownerships (most expensive)
		uint256 len = legacyMultiAccounts.length;
		for (uint256 i = 0; i < len; i++) {
			(bool success, bytes memory data) = legacyMultiAccounts[i].staticcall(abi.encodeWithSignature("owners(address)", account));

			if (success && data.length >= 32) {
				address owner = abi.decode(data, (address));
				if (owner == user) {
					return true;
				}
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
		require(vData.openPositionCount == 0, "AccountsHub: Open positions exist");

		address parentAccount = vData.parentAccount;
		address collateral = ISymmio(symmioAddress).getCollateral();
		uint8 decimals = IERC20Metadata(collateral).decimals();
		require(decimals <= 18, "AccountsHub: Invalid token decimals");

		// Deallocate all funds before deletion
		uint256 allocatedBalance = ISymmio(symmioAddress).allocatedBalanceOfPartyA(account);
		if (allocatedBalance > 0) {
			// Use the 18-decimal balance directly for deallocation
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.deallocate.selector, allocatedBalance));
		}

		// Transfer remaining balance to parent
		uint256 balance = ISymmio(symmioAddress).balanceOf(account);
		if (balance > 0) {
			_executeWithSigner(account, abi.encodeWithSelector(ISymmio.internalTransfer.selector, parentAccount, balance));
		}

		// Mark as deleted (keep data for trackers)
		vData.isDeleted = true;
		subAccounts[parentAccount].virtualAccountCount--;

		emit VirtualAccountDeleted(account, parentAccount);
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
}