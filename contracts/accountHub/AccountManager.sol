// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAccountManager.sol";
import "./interfaces/IAccountHub.sol";
import "./interfaces/ISymmio.sol";

contract AccountManager is IAccountManager {
	using SafeERC20 for IERC20;

	address public hub;

	modifier onlyHub() {
		require(msg.sender == hub, "AccountManager: Only hub");
		_;
	}

	modifier withSigner(address signer) {
		IAccountHub(hub).setSigner(signer);
		_;
		IAccountHub(hub).setSigner(address(0));
	}

	constructor(address _hub) {
		hub = _hub;
	}

	function addAccount(string memory name) external withSigner(msg.sender) returns (address[] memory) {
		address[] memory cores = IAccountHub(hub).affiliateSymmioCores(address(this));

		IAccountHub.SubAccountCreationData memory acc = IAccountHub.SubAccountCreationData({
			name: name,
			metadata: hex"",
			relatedCore: cores[0],
			initialDeposit: 0
		});

		IAccountHub.SubAccountCreationData[] memory arr;

		arr[0] = acc;

		return IAccountHub(hub).batchCreateSubAccounts(address(this), arr);
	}

	function depositForAccount(address account, uint256 amount) external withSigner(msg.sender) {
		address core = IAccountHub(hub).getRelatedCore(account);
		address collateral = ISymmio(core).getCollateral();
		IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20(collateral).safeIncreaseAllowance(hub, amount);

		IAccountHub(hub).depositForAccount(account, amount);
	}

	function allocateForAccount(address account, uint256 amount) external withSigner(msg.sender) {
		address core = IAccountHub(hub).getRelatedCore(account);
		IAccountHub(hub).allocateForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external withSigner(msg.sender) {
		address core = IAccountHub(hub).getRelatedCore(account);

		address collateral = ISymmio(core).getCollateral();
		IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20(collateral).safeIncreaseAllowance(hub, amount);

		IAccountHub(hub).depositAndAllocateForAccount(account, amount);
	}

	function withdrawFromAccount(address account, uint256 amount) external withSigner(msg.sender) {
		IAccountHub(hub).withdrawFromAccount(account, amount);
	}

	function _call(address account, bytes[] memory callDatas) external withSigner(msg.sender) {
		IAccountHub(hub)._call(account, callDatas);
	}

	function getHub() external view returns (address) {
		return hub;
	}
}
