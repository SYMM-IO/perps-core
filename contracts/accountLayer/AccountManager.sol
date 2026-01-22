// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountManager, Account } from "./interfaces/IAccountManager.sol";
import { IAccountLayerDiamond } from "./interfaces/IAccountLayerDiamond.sol";
import { ICoreFacet } from "./facets/Core/ICoreFacet.sol";
import { SubAccountCreationData, SubAccountDetail, SubAccountIsolationType } from "./storages/AccountHubStorage.sol";
import { ISymmio } from "./interfaces/ISymmio.sol";
import { IAccountLayerErrors } from "./interfaces/IAccountLayerErrors.sol";

contract AccountManager is IAccountManager, IAccountLayerErrors {
	address public accountHub;

	modifier withSigner() {
		IAccountLayerDiamond(accountHub).setSigner(msg.sender);
		_;
		IAccountLayerDiamond(accountHub).setSigner(address(0));
	}

	constructor(address _accountHub) {
		if (_accountHub == address(0)) revert ZeroAddress();
		accountHub = _accountHub;
	}

	function addAccount(string memory name) external withSigner returns (address[] memory subAccountAddress) {
		address[] memory cores = IAccountLayerDiamond(accountHub).getAffiliateSymmioCores(address(this));

		SubAccountCreationData memory acc = SubAccountCreationData({
			name: name,
			metadata: hex"",
			symmioCore: cores[0],
			isolationType: SubAccountIsolationType.CUSTOM,
			singleVAMode: false
		});

		SubAccountCreationData[] memory arr = new SubAccountCreationData[](1);
		arr[0] = acc;

		subAccountAddress = IAccountLayerDiamond(accountHub).createSubAccounts(address(this), arr);
		emit AddAccount(msg.sender, subAccountAddress[0], name);
	}

	function depositForAccount(address account, uint256 amount) external withSigner {
		ICoreFacet(accountHub).depositForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external withSigner {
		ICoreFacet(accountHub).depositAndAllocateForAccount(account, amount);
	}

	function depositForAccountWithExpressRate(
		address account,
		uint256 amount
	) external withSigner {
		ICoreFacet(accountHub).depositForAccountWithExpressRate(account, amount);
	}

	function depositAndAllocateForAccountWithExpressRate(
		address account,
		uint256 amount
	) external withSigner {
		ICoreFacet(accountHub).depositAndAllocateForAccountWithExpressRate(account, amount);
	}

	function withdrawFromAccount(address account, uint256 amount) external withSigner {
		_withdrawFromAccount(account, msg.sender, amount);
	}

	function withdrawFromAccountTo(address account, address to, uint256 amount) external withSigner {
		if (to == address(0)) revert ZeroAddress();
		_withdrawFromAccount(account, to, amount);
	}

	function _call(address account, bytes[] memory callDatas) external withSigner {
		IAccountLayerDiamond(accountHub)._call(account, callDatas);
	}

	function getAccountHub() external view returns (address) {
		return accountHub;
	}

	function getAccounts(address user, uint256 start, uint256 size) external view returns (Account[] memory) {
		uint256 total = IAccountLayerDiamond(accountHub).getSubAccountsCountOfUser(user);

		if (start >= total) {
			return new Account[](0);
		}

		uint256 remaining = total - start;
		uint256 resultSize = remaining < size ? remaining : size;

		SubAccountDetail[] memory details = IAccountLayerDiamond(accountHub).getUserSubAccounts(user, start, resultSize);

		Account[] memory accounts = new Account[](resultSize);
		for (uint256 i = 0; i < resultSize; i++) {
			accounts[i] = Account({ accountAddress: details[i].accountAddress, name: details[i].name });
		}
		return accounts;
	}

	function getAccountsLength(address user) external view returns (uint256) {
		return IAccountLayerDiamond(accountHub).getSubAccountsCountOfUser(user);
	}

	function _withdrawFromAccount(address account, address to, uint256 amount) private {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSelector(ISymmio.withdrawTo.selector, to, amount);
		IAccountLayerDiamond(accountHub)._call(account, callDatas);
	}
}
