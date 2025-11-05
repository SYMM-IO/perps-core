// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity ^0.8.18;

import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./IAccountHub.sol";
import "./ISymmio.sol";
import "./IAccountManager.sol";
import "./IHook.sol";

contract AccountsHub is IAccountHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;

	// ==================== Roles ====================
	bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	// ==================== Storage ====================
	address public symmioAddress;
	address public symmioFeeReceiver;
	address public accountManagerImplementation;

	mapping(address => AffiliateData) public Affiliates;
	mapping(address => PendingFeeUpdate) public pendingFeeUpdates;

	// Account related storage
	mapping(address => SubAccountData) public subAccounts; // subAccountAddress => SubAccountData
	mapping(address => VirtualAccountData) public virtualAccounts; // virtualAccount => virtualAccountData
	mapping(address => address[]) userToSubAccounts;
	mapping(address => address[]) userToVirtualAccounts;
	mapping(address => mapping(address => uint256)) public userAccountNonce; // user => Affiliate => nonce

	//* Legacy support
	mapping(address => address) public legacyAccountToMultiAccount; // account => old MultiAccount contract

	// Hook system: Affiliate => selector => hook contract
	mapping(address => mapping(bytes4 => address)) public AffiliateHooks;

	// For backward compatibility - maintain old structure
	mapping(address => Account[]) public legacyAccounts; // user => accounts array
	mapping(address => uint256) public legacyIndexOfAccount; // account => index in user's array
	mapping(address => address) public legacyOwners; // account => owner

	bytes32 private constant ACCOUNT_INIT_CODE_HASH = keccak256("ACCOUNT_V1");
	bytes32 private constant VIRTUAL_ACCOUNT_INIT_CODE_HASH = keccak256("VIRTUAL_ACCOUNT_V1");

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(
		address _admin,
		address _symmioAddress,
		address _symmioFeeReceiver,
		address _accountManagerImplementation
	) public initializer {
		require(_admin != address(0), "AccountsHub: Zero admin");
		require(_symmioAddress != address(0), "AccountsHub: Zero symmio");
		require(_symmioFeeReceiver != address(0), "AccountsHub: Zero fee receiver");

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
		require(Affiliates[msg.sender].state == AffiliateState.NONE, "AccountsHub: Already registered");
		require(reg.admin != address(0), "AccountsHub: Zero admin");
		require(bytes(reg.name).length > 0, "AccountsHub: Empty name");
		require(reg.symmioShare <= 1e18, "AccountsHub: Invalid Symmio share");

		uint256 totalShare = reg.symmioShare;
		for (uint256 i = 0; i < reg.stakeholders.length; i++) {
			require(reg.stakeholders[i].receiver != address(0), "AccountsHub: Zero stakeholder");
			totalShare += reg.stakeholders[i].share;
		}
		require(totalShare == 1e18, "AccountsHub: Shares must sum to 100%");

		AffiliateData storage Affiliate = Affiliates[msg.sender];
		Affiliate.name = reg.name;
		Affiliate.brandColor = reg.brandColor;
		Affiliate.admin = reg.admin;
		Affiliate.state = AffiliateState.PENDING;
		Affiliate.symmioShare = reg.symmioShare;
		Affiliate.metadata = reg.metadata;
		Affiliate.stakeholders = reg.stakeholders;
		Affiliate.legacyMultiAccounts = reg.legacyMultiAccounts;

		emit AffiliateRegistered(msg.sender, reg.name);
	}

	function cancelRegistration() external {
		require(Affiliates[msg.sender].state == AffiliateState.PENDING, "AccountsHub: Not pending");
		delete Affiliates[msg.sender];
		emit RegistrationCancelled(msg.sender);
	}

	function approveAffiliate(address Affiliate) external onlyRole(APPROVER_ROLE) {
		require(Affiliates[Affiliate].state == AffiliateState.PENDING, "AccountsHub: Not pending");

		// Deploy Account Manager for this Affiliate
		address accountManager = _deployAccountManager(Affiliate);

		Affiliates[Affiliate].state = AffiliateState.ACTIVE;
		Affiliates[Affiliate].accountManager = accountManager;

		emit AffiliateApproved(Affiliate, accountManager);
	}

	function updateAffiliateDetails(string memory name, string memory brandColor) external {
		require(Affiliates[msg.sender].state == AffiliateState.ACTIVE, "AccountsHub: Not active");
		require(Affiliates[msg.sender].admin == msg.sender, "AccountsHub: Not admin");

		Affiliates[msg.sender].name = name;
		Affiliates[msg.sender].brandColor = brandColor;

		emit AffiliateUpdated(msg.sender, name, brandColor);
	}

	function requestFeeUpdate(Stakeholder[] memory newStakeholders, uint256 newSymmioShare) external {
		require(Affiliates[msg.sender].state == AffiliateState.ACTIVE, "AccountsHub: Not active");
		require(Affiliates[msg.sender].admin == msg.sender, "AccountsHub: Not admin"); // TODO :::
		require(newSymmioShare <= 1e18, "AccountsHub: Invalid Symmio share");

		// Validate shares
		uint256 totalShare = newSymmioShare;
		for (uint256 i = 0; i < newStakeholders.length; i++) {
			require(newStakeholders[i].receiver != address(0), "AccountsHub: Zero stakeholder");
			totalShare += newStakeholders[i].share;
		}
		require(totalShare == 1e18, "AccountsHub: Shares must sum to 100%");

		// Store pending update
		delete pendingFeeUpdates[msg.sender].stakeholders;
		PendingFeeUpdate storage pending = pendingFeeUpdates[msg.sender];
		pending.symmioShare = newSymmioShare;
		pending.timestamp = block.timestamp;
		pending.exists = true;

		for (uint256 i = 0; i < newStakeholders.length; i++) {
			pending.stakeholders.push(newStakeholders[i]);
		}

		emit StakeholdersUpdateRequested(msg.sender);
	}

	function approveFeeUpdate(address Affiliate) external onlyRole(APPROVER_ROLE) {
		require(pendingFeeUpdates[Affiliate].exists, "AccountsHub: No pending update");

		// Apply the update
		delete Affiliates[Affiliate].stakeholders;
		Affiliates[Affiliate].symmioShare = pendingFeeUpdates[Affiliate].symmioShare;

		for (uint256 i = 0; i < pendingFeeUpdates[Affiliate].stakeholders.length; i++) {
			Affiliates[Affiliate].stakeholders.push(pendingFeeUpdates[Affiliate].stakeholders[i]);
		}

		delete pendingFeeUpdates[Affiliate];
		emit StakeholdersUpdated(Affiliate);
	}

	function pauseAffiliate(address Affiliate, bool pause) external {
		require(
			hasRole(PAUSER_ROLE, msg.sender) || (Affiliates[Affiliate].admin == msg.sender && Affiliates[Affiliate].state == AffiliateState.ACTIVE),
			"AccountsHub: Unauthorized"
		);

		if (pause) {
			Affiliates[Affiliate].state = AffiliateState.PAUSED;
		} else {
			require(Affiliates[Affiliate].state == AffiliateState.PAUSED, "AccountsHub: Not paused");
			Affiliates[Affiliate].state = AffiliateState.ACTIVE;
		}

		emit AffiliatePaused(Affiliate, pause);
	}

	function createSubAccount(
		address affiliate,
		string memory name,
		bytes memory metadata
	) public whenNotPaused nonReentrant returns (address account) {
		require(Affiliates[affiliate].state == AffiliateState.ACTIVE, "AccountsHub: affiliate not active");

		// Generate deterministic address
		uint256 nonce = userAccountNonce[msg.sender][affiliate]++;
		account = _generateSubAccountAddress(affiliate, msg.sender, nonce);

		// Store account data
		subAccounts[account] = SubAccountData({
			owner: msg.sender,
			Affiliate: affiliate,
			name: name,
			metadata: metadata,
			exists: true,
			virtualAccountCount: 0,
			nonce: 0
		});
		userToSubAccounts[msg.sender].push(account);

		// Update backward compatibility mappings
		legacyOwners[account] = msg.sender;
		legacyIndexOfAccount[account] = legacyAccounts[msg.sender].length;
		legacyAccounts[msg.sender].push(Account(account, name));

		// Call hook if set
		_callHook(affiliate, this.onAccountCreation.selector, abi.encode(account, metadata));

		emit SubAccountCreated(account, msg.sender, affiliate, name);
		emit AddAccount(msg.sender, account, name); // Legacy event

		return account;
	}

	function batchCreateSubAccounts(
		address affiliate,
		SubAccountCreationData[] memory accountsData
	) external whenNotPaused nonReentrant returns (address[] memory) {
		address[] memory createdAccounts = new address[](accountsData.length);

		for (uint256 i = 0; i < accountsData.length; i++) {
				createdAccounts[i] = createSubAccount(affiliate, accountsData[i].name, accountsData[i].metadata);

				if (accountsData[i].initialDeposit > 0) {
					depositForAccount(createdAccounts[i], accountsData[i].initialDeposit);
				}
		}

		return createdAccounts;
	}

	function createVirtualAccount(
		address parentAccount,
		IsolationType isolationType,
		uint256 marketId
	) public whenNotPaused nonReentrant returns (address virtualAccount) {
		require(subAccounts[parentAccount].exists, "AccountsHub: Invalid parent");
		require(_isOwnerOf(parentAccount, msg.sender), "AccountsHub: Not owner");

		uint256 nonce = subAccounts[parentAccount].nonce++;
		virtualAccount = _generateVirtualAccountAddress(parentAccount, nonce);

		virtualAccounts[virtualAccount] = VirtualAccountData({
			parentAccount: parentAccount,
			isDeleted: false,
			isolationType: isolationType,
			marketId: marketId,
			createdAt: block.timestamp
		});

		subAccounts[parentAccount].virtualAccountCount++;
		legacyOwners[virtualAccount] = msg.sender;

		// Call hook if set
		address affiliate = subAccounts[parentAccount].affiliate;
		_callHook(affiliate, this.onVirtualAccountCreation.selector, abi.encode(virtualAccount, parentAccount));

		emit VirtualAccountCreated(virtualAccount, parentAccount, isolationType);

		return virtualAccount;
	}

	// function batchCreateVirtualAccount(
	// 	address parentAccount,
	// 	VirtualAccountCreationData[] memory accountsData
	// ) external whenNotPaused nonReentrant returns (address[] memory) {
	// 	address[] memory createdAccounts = new address[](accountsData.length);

	// 	for (uint256 i = 0; i < accountsData.length; i++) {
	// 			createdAccounts[i] = createVirtualAccount(parentAccount, accountsData[i].isolationType, accountsData[i].marketId);

	// 			if (accountsData[i].initialDeposit > 0) {
	// 				depositForAccount(createdAccounts[i], accountsData[i].initialDeposit);
	// 			}
	// 	}

	// 	return createdAccounts;
	// }

	function createVirtualAndSendQuote(
		address parentAccount,
		IsolationType isolationType,
		bytes calldata quoteData
	) external whenNotPaused nonReentrant returns (address virtualAccount) {
		virtualAccount = createVirtualAccount(parentAccount, isolationType, 0); // TODO ::: what about market isolation?

		// Execute sendQuote through the virtual account
		_executeCall(virtualAccount, quoteData);

		// TODO ::: we should hold state about the quote and markets of the sendQuotes to be able delete a virtual account when settled

		return virtualAccount;
	}

	// function checkAndDeleteVirtualAccounts(address[] calldata accounts) external {
	// 	for (uint256 i = 0; i < accounts.length; i++) {
	// 		address account = accounts[i];
	// 		VirtualAccountData storage vData = virtualAccounts[account];

	// 		if (vData.parentAccount != address(0) && !vData.isDeleted) {
	// 			// Check if account should be deleted based on isolation type
	// 			if (_shouldDeleteVirtualAccount(account)) {
	// 				_deleteVirtualAccount(account);
	// 			}
	// 		}
	// 	}
	// }

	function editAccountName(address account, string memory name) external whenNotPaused {
		require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");

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

	 function depositForAccount(address account, uint256 amount) public whenNotPaused nonReentrant {
        require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
        
        address collateral = ISymmio(symmioAddress).getCollateral();
        IERC20Upgradeable(collateral).safeTransferFrom(msg.sender, address(this), amount);
        IERC20Upgradeable(collateral).safeApprove(symmioAddress, amount);
        
        _executeWithSigner(account, abi.encodeWithSelector(ISymmio.depositFor.selector, account, amount));
        
        // Call hook if set
        address affiliate = _getFrontendForAccount(account);
        _callHook(affiliate, this.onDeposit.selector, abi.encode(account, amount));
        
        emit DepositForAccount(msg.sender, account, amount);
    }

    function depositAndAllocateForAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
        require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
        
        // Deposit
        depositForAccount(account, amount);
        
        // Allocate
        address collateral = ISymmio(symmioAddress).getCollateral();
        uint256 amountWith18Decimals = (amount * 1e18) / (10 ** IERC20Metadata(collateral).decimals());
        
        _executeWithSigner(account, abi.encodeWithSelector(ISymmio.allocate.selector, amountWith18Decimals)); // TODO ::: use the "depositAndAllocateFor" instead of "ISymmio.allocate.selector"
        
        emit AllocateForAccount(msg.sender, account, amountWith18Decimals);
    }

    function withdrawFromAccount(address account, uint256 amount) external whenNotPaused nonReentrant {
        require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
        
        _executeWithSigner(account, abi.encodeWithSelector(ISymmio.withdrawTo.selector, msg.sender, amount));
        
        // Call hook if set
        address affiliate = _getFrontendForAccount(account);
        _callHook(affiliate, this.onWithdraw.selector, abi.encode(account, amount));
        
        emit WithdrawFromAccount(msg.sender, account, amount);
    }

    function _call(address account, bytes[] memory _callDatas) external whenNotPaused nonReentrant {
        require(_isOwnerOf(account, msg.sender), "AccountsHub: Not owner");
        
        for (uint256 i = 0; i < _callDatas.length; i++) {
            // Check if first call should create virtual account
            if (i == 0 && _shouldCreateVirtual(_callDatas[i])) {
                address virtualAccount = createVirtualAccount(account, IsolationType.POSITION, 0);
                _executeCall(virtualAccount, _callDatas[i]);
                account = virtualAccount; // Use virtual for remaining calls
            } else {
                _executeCall(account, _callDatas[i]);
            }
        }
    }

	 function setHook(bytes4 selector, address hook) external {
        require(Affiliates[msg.sender].state == AffiliateState.ACTIVE, "AccountsHub: Not active");
        require(Affiliates[msg.sender].admin == msg.sender, "AccountsHub: Not admin");
        
        AffiliateHooks[msg.sender][selector] = hook;
        emit HookSet(msg.sender, selector, hook);
    }

    function removeHook(bytes4 selector) external {
        require(Affiliates[msg.sender].admin == msg.sender, "AccountsHub: Not admin");
        
        delete AffiliateHooks[msg.sender][selector];
        emit HookRemoved(msg.sender, selector);
    }
	
	function _deployAccountManager(address frontend) internal returns (address) {
        // Deploy minimal proxy
        bytes memory bytecode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            accountManagerImplementation,
            hex"5af43d82803e903d91602b57fd5bf3"
        );
        
        bytes32 salt = keccak256(abi.encodePacked("AccountManager", frontend));
        address accountManager;
        
        assembly {
            accountManager := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        
        require(accountManager != address(0), "AccountsHub: Deployment failed");
        
        // Initialize the account manager
        IAccountManager(accountManager).initialize(address(this), frontend);
        
        return accountManager;
    }

    function _generateSubAccountAddress(
        address frontend,
        address user,
        uint256 nonce
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            frontend, // Use frontend as deployer for uniqueness
            keccak256(abi.encodePacked(user, nonce)),
            ACCOUNT_INIT_CODE_HASH
        )))));
    }

    function _generateVirtualAccountAddress(
        address parentAccount,
        uint256 nonce
    ) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            parentAccount,
            keccak256(abi.encodePacked("VIRTUAL", nonce)),
            VIRTUAL_ACCOUNT_INIT_CODE_HASH
        )))));
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
    }

    function _executeCall(address account, bytes memory callData) internal {
        _executeWithSigner(account, callData);
        emit Call(msg.sender, account, callData, true, "");
    }

    function _isOwnerOf(address account, address user) internal view returns (bool) {
        // Check direct ownership
        if (legacyOwners[account] == user) return true;
        
        // Check if it's a virtual account
        if (virtualAccounts[account].parentAccount != address(0)) {
            return _isOwnerOf(virtualAccounts[account].parentAccount, user);
        }
        
        // Check legacy accounts
        address legacyMultiAccount = legacyAccountToMultiAccount[account];
        if (legacyMultiAccount != address(0)) {
            // Call legacy contract to check ownership
            (bool success, bytes memory data) = legacyMultiAccount.staticcall(
                abi.encodeWithSignature("owners(address)", account)
            );
            if (success && data.length > 0) {
                address owner = abi.decode(data, (address));
                return owner == user;
            }
        }
        
        return false;
    }

    function _getFrontendForAccount(address account) internal view returns (address) {
        if (subAccounts[account].exists) {
            return subAccounts[account].frontend;
        }
        
        if (virtualAccounts[account].parentAccount != address(0)) {
            return _getFrontendForAccount(virtualAccounts[account].parentAccount);
        }
        
        return address(0);
    }

    function _shouldCreateVirtual(bytes memory callData) internal pure returns (bool) {
        if (callData.length < 4) return false;
        
        bytes4 selector;
        assembly {
            selector := mload(add(callData, 32))
        }
        
        // Check if it's sendQuote or similar function that might need isolation
        return selector == bytes4(keccak256("sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,(uint256,uint256,uint256,bytes,bytes))"));
    }

    function _shouldDeleteVirtualAccount(address account) internal view returns (bool) {
        // This would call Symmio to check open positions
        // Simplified for now - actual implementation would check position count
        return false; // Placeholder
    }

    function _deleteVirtualAccount(address account) internal {
        VirtualAccountData storage vData = virtualAccounts[account];
        require(!vData.isDeleted, "AccountsHub: Already deleted");
        
        address parentAccount = vData.parentAccount;
        
        // Transfer remaining balance to parent
        uint256 balance = ISymmio(symmioAddress).balanceOf(account);
        if (balance > 0) {
            address collateral = ISymmio(symmioAddress).getCollateral();
            uint256 adjustedBalance = balance / (10 ** (18 - IERC20Metadata(collateral).decimals()));
            _executeWithSigner(account, abi.encodeWithSelector(ISymmio.withdrawTo.selector, parentAccount, adjustedBalance));
        }
        
        // Mark as deleted (keep data for trackers)
        vData.isDeleted = true;
        subAccounts[parentAccount].virtualAccountCount--;
        
        emit VirtualAccountDeleted(account, parentAccount);
    }

    function _callHook(address frontend, bytes4 selector, bytes memory data) internal {
        address hook = AffiliateHooks[frontend][selector];
        if (hook != address(0)) {
            (bool success, bytes memory result) = hook.call(
                abi.encodeWithSelector(selector, data)
            );
            
            if (!success) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
        }
    }
}
