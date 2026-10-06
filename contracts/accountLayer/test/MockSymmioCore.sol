// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockSymmioCore {
	address public collateral;
	address public signer;
	mapping(address => uint256) private balances;
	mapping(address => address) public feeCollectors;

	function setCollateral(address _collateral) external {
		require(_collateral != address(0), "invalid collateral");
		collateral = _collateral;
	}

	function setSigner(address _signer) external {
		signer = _signer;
	}

	function setFeeCollector(address affiliate, address feeCollector) external {
		feeCollectors[affiliate] = feeCollector;
	}

	function registerAffiliate(address) external {}

	function getCollateral() external view returns (address) {
		return collateral;
	}

	function balanceOf(address user) external view returns (uint256) {
		return balances[user];
	}

	function depositFor(address payee, uint256 amount) external {
		require(collateral != address(0), "collateral not set");
		IERC20(collateral).transferFrom(msg.sender, address(this), amount);
		balances[payee] += amount;
	}

	function withdrawTo(address receiver, uint256 amount) external {
		require(collateral != address(0), "collateral not set");
		address payer = signer == address(0) ? msg.sender : signer;
		require(balances[payer] >= amount, "insufficient mock balance");
		balances[payer] -= amount;
		IERC20(collateral).transfer(receiver, amount);
	}
}
