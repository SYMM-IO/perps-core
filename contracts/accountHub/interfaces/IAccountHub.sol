// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IAccountHub {
	enum AffiliateState {
		NONE,
		PENDING,
		ACTIVE,
		PAUSED,
		DEACTIVATED
	}
	enum IsolationType {
		NONE,
		POSITION,
		MARKET_LONG,
		MARKET_SHORT
	}

	struct Stakeholder {
		address receiver;
		uint256 share; // in 18 decimals, must sum to 100% - symmioShare
	}

	struct FeeDetails {
		uint256 symmioShare;
		Stakeholder[] stakeholders;
	}

	struct AffiliateData {
		string name;
		string brandColor;
		address admin;
		address pendingAdmin;
		AffiliateState state;
		FeeDetails feeDetails;
		bytes metadata;
		address accountManager;
		address feeDistributor;
		address[] legacyMultiAccounts;
		address[] symmioCores;
		mapping(bytes4 => address) hooks;
	}

	struct AffiliateRegistration {
		string name;
		string brandColor;
		address admin;
		Stakeholder[] stakeholders;
		uint256 symmioShare;
		bytes metadata;
		address[] legacyMultiAccounts;
		address[] symmioCores;
	}

	struct PendingFeeUpdate {
		Stakeholder[] stakeholders;
		uint256 symmioShare;
		uint256 timestamp;
		bool exists;
	}

	struct SubAccountData {
		address owner;
		address affiliate;
		string name;
		bytes metadata;
		bool exists;
		uint256 virtualAccountCount;
		address relatedCore;
		uint256 nonce; // for generating virtual accounts
	}

	struct VirtualAccountData {
		address parentAccount;
		bool isDeleted;
		IsolationType isolationType;
		uint256 marketId; // For market isolation (symbolId)
		uint256 quoteId;
		uint256 createdAt;
		bytes metadata;
	}

	struct SubAccountCreationData {
		string name;
		bytes metadata;
		address relatedCore;
		uint256 initialDeposit;
	}

	struct VirtualAccountCreationData {
		bytes metadata;
		IsolationType isolationType;
		uint256 marketId; // For market isolation (symbolId)
		uint256 initialDeposit;
	}

	struct Account {
		address accountAddress;
		string name;
	}

	// Affiliate events
	event AffiliateRegistered(address indexed Affiliate, string name);
	event AffiliateApproved(address indexed Affiliate, address accountManager);
	event AffiliateUpdated(address indexed Affiliate, string name, string brandColor);
	event AffiliatePaused(address indexed Affiliate, bool paused);
	event AffiliateDeactivated(address indexed Affiliate);
	event StakeholdersUpdateRequested(address indexed Affiliate);
	event StakeholdersUpdated(address indexed Affiliate);
	event RegistrationCancelled(address indexed Affiliate);

	// Account events
	event SubAccountCreated(address indexed account, address indexed owner, address indexed Affiliate, string name);
	event VirtualAccountCreated(address indexed account, address indexed parent, IsolationType isolationType);
	event VirtualAccountDeleted(address indexed account, address indexed parent);

	// Legacy compatibility events
	event AddAccount(address indexed user, address indexed account, string name);
	event EditAccountName(address indexed user, address indexed account, string name);
	event DepositForAccount(address indexed sender, address indexed account, uint256 amount);
	event AllocateForAccount(address indexed sender, address indexed account, uint256 amount);
	event WithdrawFromAccount(address indexed sender, address indexed account, uint256 amount);
	event Call(address indexed sender, address indexed account, bytes callData, bool success, bytes resultData);

	// Fee events
	event FeesDistributed(address indexed recipient, uint256 amount);
	event FeesClaimed(uint256 amount);
	event FeeUpdateCancelled(address indexed Affiliate);
	event SymmioFeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

	// Hook events
	event HookSet(address indexed Affiliate, bytes4 indexed selector, address hook);
	event HookRemoved(address indexed Affiliate, bytes4 indexed selector);

	event SymmioAddressSet(address indexed symmioAddress);

	event AvailableCoreSet(address indexed core, bool status);

	event AdminTransferProposed(address indexed affiliate, address indexed newAdmin);
	event AdminTransferCompleted(address indexed affiliate, address indexed oldAdmin, address indexed newAdmin);
	event AdminTransferCancelled(address indexed affiliate);

	function createSubAccount(address affiliate, string memory name, address relatedCore, bytes memory metadata) external returns (address account);
	function depositForAccount(address account, uint256 amount) external;
	function withdrawFromAccount(address account, uint256 amount) external;
	function _call(address account, bytes[] memory _callDatas) external;

	error ZeroAddress();
	error InvalidNameLength();
	error InvalidShare();
	error SharesMustSumTo100();
	error AlreadyRegistered();
	error NotAdmin();
	error NotPending();
	error AffiliateNotActive();
	error NotSymmioCore();
	error EmptyArray();
	error InvalidCore();
	error NotOwner();
	error ZeroAmount();
	error AlreadyDeleted();
	error OpenPositionsExist();
	error InvalidTokenDecimals();
	error InvalidFunctionSelector();
	error InvalidMarketId();
	error InvalidIsolationType();
	error NotVirtualAccount();
	error AccountDeleted();
	error NoPendingUpdate();
	error Unauthorized();
	error NotPaused();
	error DeploymentFailed();
}
