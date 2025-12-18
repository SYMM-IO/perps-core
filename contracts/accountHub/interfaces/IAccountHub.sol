// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./ISymmio.sol";

interface IAccountHub {
	enum VirtualAccountIsolationType {
		POSITION,
		MARKET,
		MARKET_LONG,
		MARKET_SHORT
	}

	enum SubAccountIsolationType {
		POSITION,
		MARKET,
		MARKET_DIRECTION,
		CUSTOM
	}

	struct SubAccountData {
		string name;
		address owner;
		bool isExists;
		bytes metadata;
		address affiliate;
		address symmioCore;
		SubAccountIsolationType isolationType;
	}

	struct VirtualAccountData {
		bool isExists;
		bytes metadata;
		address parentAccount;
		uint256 symbolId; // For market isolation (symbolId), For position and cross isolation should be 0
		VirtualAccountIsolationType isolationType;
		EnumerableSet.UintSet quoteIds;
	}

	struct SubAccountCreationData {
		string name;
		bytes metadata;
		address symmioCore;
		SubAccountIsolationType isolationType;
	}

	struct VirtualAccountCreationData {
		bytes metadata;
		uint256 symbolId; // For market isolation (symbolId), For position and cross isolation should be 0
		uint256 initialDeposit;
	}

	struct Account {
		address accountAddress;
		string name;
	}

	struct QuoteParams {
		uint256 symbolId;
		ISymmio.PositionType positionType;
		uint256 cva;
		uint256 lf;
		uint256 partyAmm;
		uint256 quantity;
		uint256 price;
		ISymmio.OrderType OrderType;
		ISymmio.SingleUpnlAndPriceSig sig;
		address affiliate;
	}

	struct SubAccountDetail {
		address accountAddress;
		address owner;
		string name;
		bool isExists;
		address affiliate;
		address symmioCore;
		bytes metadata;
		SubAccountIsolationType isolationType;
	}

	struct VirtualAccountDetail {
		address accountAddress;
		address parentAccount;
		uint256 symbolId;
		bool isExists;
		bytes metadata;
		VirtualAccountIsolationType isolationType;
	}

	// Account events
	event SubAccountCreated(address indexed account, address indexed owner, address indexed affiliate, string name);
	event VirtualAccountCreated(address indexed account, address indexed parent);
	event VirtualAccountReused(address indexed account, address indexed parent);
	event VirtualAccountDeleted(address indexed account, address indexed parent);

	// Transfer events
	event AddMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
	event RemoveMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);

	// Legacy compatibility events
	event EditAccountName(address indexed account, string name);
	event DepositForAccount(address indexed sender, address indexed account, uint256 amount);
	event AllocateForAccount(address indexed sender, address indexed account, uint256 amount);
	event WithdrawFromAccount(address indexed sender, address indexed account, uint256 amount);
	event Call(address indexed sender, address indexed account, bytes callData, bool success, bytes resultData);

	// AccountManager events
	event AccountManagerDeployed(address indexed affiliate, address indexed accountManager);

	// Account management
	function createSubAccounts(address affiliate, SubAccountCreationData[] memory accountsData) external returns (address[] memory);
	function editAccountName(address account, string memory name) external;
	function _call(address account, bytes[] calldata _callDatas) external returns (bytes[] memory);

	// Symmio callback
	function onClosePosition(uint256 quoteId, uint256 _filledAmount, uint256 _closedPrice, address partyA, address _partyB) external;

	// View functions
	function affiliateHub() external view returns (address);
	function accountManagerImplementation() external view returns (bytes memory);
	function getSigner() external view returns (address);
	function getRelatedCore(address account) external view returns (address);
	function ownerOf(address account) external view returns (address);
	function getSubAccountVirtualNonce(address subAccount) external view returns (uint256);
	function predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) external view returns (address);
	function setSigner(address _signer) external;
	function getSubAccount(address account) external view returns (SubAccountDetail memory);
	function getUserSubAccounts(address owner, uint256 offset, uint256 limit) external view returns (SubAccountDetail[] memory details);
	function getUserSubAccountsAddresses(address owner, uint256 offset, uint256 limit) external view returns (address[] memory);
	function getVirtualAccountsAddressesOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (address[] memory);
	function getVirtualAccount(address account) external view returns (VirtualAccountDetail memory);
	function getVirtualAccountsOfSubAccount(address subAccount, uint256 offset, uint256 limit) external view returns (VirtualAccountDetail[] memory details);
	function getVirtualAccountQuoteIds(address account, uint256 offset, uint256 limit) external view returns (uint256[] memory);
	function getSubAccountsCountOfUser(address owner) external view returns (uint256);
	function getVirtualAccountsCountOfSubAccount(address subAccount) external view returns (uint256);

	// AccountManager management
	function deployAccountManager(address affiliate, address registrant, string memory name) external returns (address accountManager);
	function generateAccountManagerAddress(address registrant, string memory name) external view returns (address);
	function setAccountManagerImplementation(bytes memory implementation) external;

	function addMargin(address virtualAccount, uint256 amount) external;
	function addMarginToNextVA(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId, uint256 amount) external;
	function removeMargin(address virtualAccount, uint256 amount, ISymmio.SingleUpnlSig memory upnlSig) external;

	// ==================== Custom Errors ====================
	error ZeroAddress();
	error NotSymmioCore();
	error EmptyArray();
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
	error InvalidParent();
	error AccountDoesNotExist();
	error UnableToRetrieveCore();
	error InvalidSymbolId();
	error InvalidNameLength();
	error PositionTypeNotAllowedForThisAccount();
	error SymbolNotAllowedForThisAccount();
	error AffiliateNotActive();
	error OnlyCustomIsolationCanCreateManually();
	error HookFailed(bytes reason);
	error InvalidSelector();
	error DeploymentFailed();
}
