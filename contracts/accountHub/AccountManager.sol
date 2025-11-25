// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAccountManager.sol";
import "./interfaces/IAccountHub.sol";
import "./interfaces/IAffiliatesHub.sol";
import "./interfaces/ISymmio.sol";

contract AccountManager is IAccountManager {
	using SafeERC20 for IERC20;

	address public affiliatesHub;
	address public accountHub;

	modifier onlyHub() {
		require(msg.sender == affiliatesHub, "AccountManager: Only affiliates hub");
		_;
	}

	modifier withSigner() {
		IAccountHub(accountHub).setSigner(msg.sender);
		_;
		IAccountHub(accountHub).setSigner(address(0));
	}

	constructor(address _affiliatesHub) {
		affiliatesHub = _affiliatesHub;
	}

	function setAccountHub(address _accountHub) external onlyHub {
		require(_accountHub != address(0), "AccountManager: Zero address");
		accountHub = _accountHub;
	}

	function addAccount(string memory name) external withSigner returns (address[] memory subAccountAddress) {
		address[] memory cores = IAffiliatesHub(affiliatesHub).getAffiliateSymmioCores(address(this));

		IAccountHub.SubAccountCreationData memory acc = IAccountHub.SubAccountCreationData({
			name: name,
			metadata: hex"",
			symmioCore: cores[0],
			isolationType: IAccountHub.SubAccountIsolationType.CUSTOM
		});

		IAccountHub.SubAccountCreationData[] memory arr = new IAccountHub.SubAccountCreationData[](1);
		arr[0] = acc;

		subAccountAddress = IAccountHub(accountHub).createSubAccounts(address(this), arr);
		emit AddAccount(msg.sender, subAccountAddress[0], name);
	}

	function depositForAccount(address account, uint256 amount) external withSigner {
		address core = IAccountHub(accountHub).getRelatedCore(account);
		address collateral = ISymmio(core).getCollateral();
		IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20(collateral).safeIncreaseAllowance(accountHub, amount);

		IAccountHub(accountHub).depositForAccount(account, amount);
	}

	function allocateForAccount(address account, uint256 amount) external withSigner {
		IAccountHub(accountHub).allocateForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external withSigner {
		address core = IAccountHub(accountHub).getRelatedCore(account);

		address collateral = ISymmio(core).getCollateral();
		IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20(collateral).safeIncreaseAllowance(accountHub, amount);

		IAccountHub(accountHub).depositAndAllocateForAccount(account, amount);
	}

	function withdrawFromAccount(address account, uint256 amount) external withSigner {
		IAccountHub(accountHub).withdrawFromAccount(account, amount);
	}

	function _call(address account, bytes[] memory callDatas) external withSigner {
		IAccountHub(accountHub)._call(account, callDatas);
	}

	function getAffiliatesHub() external view returns (address) {
		return affiliatesHub;
	}

	function getAccountHub() external view returns (address) {
		return accountHub;
	}
}
