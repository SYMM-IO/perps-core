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
		EnumerableSet.UintSet quoteIds;
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

	// Account events
	event SubAccountCreated(address indexed account, address indexed owner, address indexed affiliate, string name);
	event VirtualAccountCreated(address indexed account, address indexed parent);
	event VirtualAccountReused(address indexed account, address indexed parent);
	event VirtualAccountDeleted(address indexed account, address indexed parent);

	// Legacy compatibility events
	event EditAccountName(address indexed account, string name);
	event DepositForAccount(address indexed sender, address indexed account, uint256 amount);
	event AllocateForAccount(address indexed sender, address indexed account, uint256 amount);
	event WithdrawFromAccount(address indexed sender, address indexed account, uint256 amount);
	event Call(address indexed sender, address indexed account, bytes callData, bool success, bytes resultData);

	// Account management
	function createSubAccounts(address affiliate, SubAccountCreationData[] memory accountsData) external returns (address[] memory);
	function editAccountName(address account, string memory name) external;
	function _call(address account, bytes[] memory _callDatas) external;

	// Symmio callback
	function onClosePosition(uint256 quoteId, uint256 _filledAmount, uint256 _closedPrice, address partyA, address _partyB) external;

	// View functions
	function getSigner() external view returns (address);
	function getRelatedCore(address account) external view returns (address);
	function getSubAccounts(address owner) external view returns (address[] memory);
	function getVirtualAccounts(address subAccount) external view returns (address[] memory);
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
		);

	function getSubAccountQuoteIds(address account) external view returns (uint256[] memory);
	// Admin functions
	function setSigner(address _signer) external;

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
}
