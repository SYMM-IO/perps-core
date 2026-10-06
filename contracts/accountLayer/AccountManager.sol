// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountManager, Account } from "./interfaces/IAccountManager.sol";
import { IAccountLayerDiamond } from "./interfaces/IAccountLayerDiamond.sol";
import { ICoreFacet } from "./facets/Core/ICoreFacet.sol";
import { SubAccountCreationData, SubAccountDetail, SubAccountIsolationType } from "./storages/AccountStorage.sol";
import { ISymmio } from "./interfaces/ISymmio.sol";
import { IAccountLayerErrors } from "./interfaces/IAccountLayerErrors.sol";

/// @notice Proxy contract deployed per affiliate that provides a backward-compatible account management interface
contract AccountManager is IAccountManager, IAccountLayerErrors {
	address public accountLayer;

	/// @notice Sets globalSigner to msg.sender before execution and clears it after
	modifier withSigner() {
		IAccountLayerDiamond(accountLayer).setSigner(msg.sender);
		_;
		IAccountLayerDiamond(accountLayer).setSigner(address(0));
	}

	/// @notice Initializes the AccountManager with a reference to the AccountLayer diamond
	/// @param _accountLayer The AccountLayer diamond address
	constructor(address _accountLayer) {
		if (_accountLayer == address(0)) revert ZeroAddress();
		accountLayer = _accountLayer;
	}

	/// @notice Creates a new sub-account with CUSTOM isolation type on the affiliate's first core
	/// @param name The display name for the sub-account
	/// @return subAccountAddress The array containing the created sub-account address
	function addAccount(string memory name) external withSigner returns (address[] memory subAccountAddress) {
		address[] memory cores = IAccountLayerDiamond(accountLayer).getAffiliateSymmioCores(address(this));

		SubAccountCreationData memory acc = SubAccountCreationData({
			name: name,
			metadata: hex"",
			symmioCore: cores[0],
			isolationType: SubAccountIsolationType.CUSTOM,
			singleVAMode: false
		});

		SubAccountCreationData[] memory arr = new SubAccountCreationData[](1);
		arr[0] = acc;

		subAccountAddress = IAccountLayerDiamond(accountLayer).createSubAccounts(address(this), arr);
		emit AddAccount(msg.sender, subAccountAddress[0], name);
	}

	/// @notice Deposits collateral for a sub-account
	/// @param account The sub-account address
	/// @param amount The amount to deposit
	function depositForAccount(address account, uint256 amount) external withSigner {
		ICoreFacet(accountLayer).depositForAccount(account, amount);
	}

	/// @notice Deposits and allocates collateral for a sub-account
	/// @param account The sub-account address
	/// @param amount The amount to deposit and allocate
	function depositAndAllocateForAccount(address account, uint256 amount) external withSigner {
		ICoreFacet(accountLayer).depositAndAllocateForAccount(account, amount);
	}

	/// @notice Deposits collateral for a sub-account using the express deposit rate
	/// @param account The sub-account address
	/// @param amount The amount to deposit
	function depositForAccountWithExpressRate(address account, uint256 amount) external withSigner {
		ICoreFacet(accountLayer).depositForAccountWithExpressRate(account, amount);
	}

	/// @notice Deposits and allocates collateral for a sub-account using the express deposit rate
	/// @param account The sub-account address
	/// @param amount The amount to deposit and allocate
	function depositAndAllocateForAccountWithExpressRate(address account, uint256 amount) external withSigner {
		ICoreFacet(accountLayer).depositAndAllocateForAccountWithExpressRate(account, amount);
	}

	/// @notice Withdraws collateral from a sub-account to the caller
	/// @param account The sub-account address
	/// @param amount The amount to withdraw
	function withdrawFromAccount(address account, uint256 amount) external withSigner {
		_withdrawFromAccount(account, msg.sender, amount);
	}

	/// @notice Withdraws collateral from a sub-account to a specified recipient
	/// @param account The sub-account address
	/// @param to The recipient address
	/// @param amount The amount to withdraw
	function withdrawFromAccountTo(address account, address to, uint256 amount) external withSigner {
		if (to == address(0)) revert ZeroAddress();
		_withdrawFromAccount(account, to, amount);
	}

	/// @notice Executes batched calls on the Symmio core for a sub-account
	/// @param account The sub-account address
	/// @param callDatas The array of encoded function calls
	function _call(address account, bytes[] memory callDatas) external withSigner {
		IAccountLayerDiamond(accountLayer)._call(account, callDatas);
	}

	/// @notice Returns the AccountLayer diamond address
	/// @return The AccountLayer address
	function getAccountLayer() external view returns (address) {
		return accountLayer;
	}

	/// @notice Returns a paginated list of accounts owned by a user
	/// @param user The user address
	/// @param start The starting index
	/// @param size The maximum number of accounts to return
	/// @return The array of Account structs
	function getAccounts(address user, uint256 start, uint256 size) external view returns (Account[] memory) {
		uint256 total = IAccountLayerDiamond(accountLayer).getSubAccountsCountOfUser(user);

		if (start >= total) {
			return new Account[](0);
		}

		uint256 remaining = total - start;
		uint256 resultSize = remaining < size ? remaining : size;

		SubAccountDetail[] memory details = IAccountLayerDiamond(accountLayer).getUserSubAccounts(user, start, resultSize);

		Account[] memory accounts = new Account[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			accounts[i] = Account({ accountAddress: details[i].accountAddress, name: details[i].name });
		}
		return accounts;
	}

	/// @notice Returns the total number of sub-accounts owned by a user
	/// @param user The user address
	/// @return The number of sub-accounts
	function getAccountsLength(address user) external view returns (uint256) {
		return IAccountLayerDiamond(accountLayer).getSubAccountsCountOfUser(user);
	}

	/// @notice Executes a withdrawTo call on the Symmio core for a sub-account
	function _withdrawFromAccount(address account, address to, uint256 amount) private {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSelector(ISymmio.withdrawTo.selector, to, amount);
		IAccountLayerDiamond(accountLayer)._call(account, callDatas);
	}
}
