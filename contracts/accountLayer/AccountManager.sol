// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IAccountManager, Account } from "./interfaces/IAccountManager.sol";
import { IAccountLayerDiamond } from "./interfaces/IAccountLayerDiamond.sol";
import { ICoreFacet } from "./facets/Core/ICoreFacet.sol";
import { SubAccountCreationData, SubAccountDetail, SubAccountIsolationType } from "./storages/AccountHubStorage.sol";
import { ISymmio } from "./interfaces/ISymmio.sol";

contract AccountManager is IAccountManager {
	using SafeERC20 for IERC20;

	address public accountHub;

	modifier withSigner() {
		IAccountLayerDiamond(accountHub).setSigner(msg.sender);
		_;
		IAccountLayerDiamond(accountHub).setSigner(address(0));
	}

	constructor(address _accountHub) {
		require(_accountHub != address(0), "AccountManager: Zero address");
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
		address core = IAccountLayerDiamond(accountHub).getRelatedCore(account);
		address collateral = ISymmio(core).getCollateral();
		IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20(collateral).safeIncreaseAllowance(accountHub, amount);

		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSelector(ISymmio.depositFor.selector, account, amount);
		IAccountLayerDiamond(accountHub)._call(account, callDatas);
	}

	function depositForAccountWithExpressRate(
		address account,
		uint256 amount
	) external withSigner {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSelector(
			ICoreFacet.depositForAccountWithExpressRate.selector,
			account,
			amount
		);
		IAccountLayerDiamond(accountHub)._call(account, callDatas);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external withSigner {
		address core = IAccountLayerDiamond(accountHub).getRelatedCore(account);

		address collateral = ISymmio(core).getCollateral();
		IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20(collateral).safeIncreaseAllowance(accountHub, amount);

		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSelector(ISymmio.depositAndAllocateFor.selector, account, amount);
		IAccountLayerDiamond(accountHub)._call(account, callDatas);
	}

	function withdrawFromAccount(address account, uint256 amount) external withSigner {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSelector(ISymmio.withdrawTo.selector, account, amount);
		IAccountLayerDiamond(accountHub)._call(account, callDatas);
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
}
