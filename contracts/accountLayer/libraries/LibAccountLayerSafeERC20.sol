// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AccountHubStorage } from "../storages/AccountHubStorage.sol";

/**
 * @title LibAccountLayerSafeERC20
 * @notice Library for safely calling ERC20 functions with signer protection
 * @dev Clears the globalSigner before calling ERC20 to prevent potential impersonation through callbacks
 */
library LibAccountLayerSafeERC20 {
	using SafeERC20 for IERC20;

	/**
	 * @notice Safely transfers tokens with signer cleared
	 * @param token The ERC20 token address
	 * @param to The recipient address
	 * @param amount The amount to transfer
	 */
	function safeTransfer(address token, address to, uint256 amount) internal {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		// Save and clear signer before external call
		address previousSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = address(0);

		IERC20(token).safeTransfer(to, amount);

		// Restore signer after external call
		ahLayout.globalSigner = previousSigner;
	}

	/**
	 * @notice Safely transfers tokens from another address with signer cleared
	 * @param token The ERC20 token address
	 * @param from The sender address
	 * @param to The recipient address
	 * @param amount The amount to transfer
	 */
	function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		// Save and clear signer before external call
		address previousSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = address(0);

		IERC20(token).safeTransferFrom(from, to, amount);

		// Restore signer after external call
		ahLayout.globalSigner = previousSigner;
	}

	/**
	 * @notice Safely increases allowance with signer cleared
	 * @param token The ERC20 token address
	 * @param spender The spender address
	 * @param amount The amount to increase allowance by
	 */
	function safeIncreaseAllowance(address token, address spender, uint256 amount) internal {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		// Save and clear signer before external call
		address previousSigner = ahLayout.globalSigner;
		ahLayout.globalSigner = address(0);

		IERC20(token).safeIncreaseAllowance(spender, amount);

		// Restore signer after external call
		ahLayout.globalSigner = previousSigner;
	}
}
