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

	struct AffiliateData {
		string name;
		string brandColor;
		address admin;
		address accountManager;
		AffiliateState state;
		uint256 symmioShare; // Symmio's percentage (e.g., 30% = 0.3e18)
		Stakeholder[] stakeholders;
		bytes metadata;
		address[] legacyMultiAccounts;
		address feeDistributor;
	}

	struct AffiliateRegistration {
		string name;
		string brandColor;
		address admin;
		Stakeholder[] stakeholders;
		uint256 symmioShare;
		bytes metadata;
		address[] legacyMultiAccounts;
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
		uint256 createdAt;
		address relatedCore;
		bytes metadata;
	}

	struct SubAccountCreationData {
		string name;
		bytes metadata;
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
	event FeesDistributed(address indexed Affiliate, uint256 total, address[] recipients, uint256[] amounts);
	event FeesClaimed(uint256 amount);
	event FeeUpdateCancelled(address indexed Affiliate);
	event SymmioFeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);

	// Hook events
	event HookSet(address indexed Affiliate, bytes4 indexed selector, address hook);
	event HookRemoved(address indexed Affiliate, bytes4 indexed selector);

	event SymmioAddressSet(address indexed symmioAddress);

	event AvailableCoreSet(address indexed core, bool status);

	function createSubAccount(address affiliate, string memory name, bytes memory metadata) external returns (address account);
	function depositForAccount(address account, uint256 amount) external;
	function withdrawFromAccount(address account, uint256 amount) external;
	function _call(address account, bytes[] memory _callDatas) external;
}
