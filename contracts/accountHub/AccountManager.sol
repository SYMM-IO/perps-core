// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./interfaces/IAccountManager.sol";
import "./interfaces/IAccountHub.sol";
import "./interfaces/ISymmio.sol";

contract AccountManager is IAccountManager, Initializable {
	using SafeERC20Upgradeable for IERC20Upgradeable;

	address public hub;
	address public affiliate;
	address public symmio;

	modifier onlyHub() {
		require(msg.sender == hub, "AccountManager: Only hub");
		_;
	}

	modifier withSigner(address signer) {
		IAccountHub(hub).setSigner(signer);
		_;
		IAccountHub(hub).setSigner(address(0));
	}

	function initialize(address _hub, address _affiliate, address _symmio) external  initializer {
		hub = _hub;
		affiliate = _affiliate;
		symmio = _symmio;
	}

	function addAccount(string memory name) external withSigner(msg.sender) returns (address) {
		return IAccountHub(hub).createSubAccount(affiliate, name, "");
	}

	function depositForAccount(address account, uint256 amount) external withSigner(msg.sender) {
		address collateral = ISymmio(symmio).getCollateral();
		IERC20Upgradeable(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20Upgradeable(collateral).safeIncreaseAllowance(hub, amount);

		IAccountHub(hub).depositForAccount(account, amount);
	}

	function depositAndAllocateForAccount(address account, uint256 amount) external withSigner(msg.sender) {
		address collateral = ISymmio(symmio).getCollateral();
		IERC20Upgradeable(collateral).safeTransferFrom(msg.sender, address(this), amount);
		IERC20Upgradeable(collateral).safeIncreaseAllowance(hub, amount);

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

	function getAffiliate() external view returns (address) {
		return affiliate;
	}
}
