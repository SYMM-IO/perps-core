// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IExternalTransferRelayer } from "../../core/interfaces/IExternalTransferRelayer.sol";
import { AccessControlEnumerable } from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAccountFacet } from "../../core/facets/Account/IAccountFacet.sol";

/// @notice Relayer that handles external collateral transfers by depositing into the target Symmio
contract ExternalTransferRelayer is IExternalTransferRelayer, AccessControlEnumerable {
	using SafeERC20 for IERC20;

	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant CALLER_ROLE = keccak256("CALLER_ROLE");

	/// @notice Emitted when a transfer is executed through the relayer
	event TransferExecuted(address collateral, address sender, address receiver, uint256 amount, address target);

	/// @notice Thrown when a zero address is provided
	error InvalidAddress();

	/// @notice Initializes the relayer with an admin address
	/// @param admin The address that receives DEFAULT_ADMIN_ROLE and SETTER_ROLE
	constructor(address admin) {
		if (admin == address(0)) revert InvalidAddress();
		_setupRole(DEFAULT_ADMIN_ROLE, admin);
		_setupRole(SETTER_ROLE, admin);
	}

	/// @notice Handles an external transfer by approving and depositing collateral into the target
	/// @param collateral The collateral token address
	/// @param sender The original sender of the transfer
	/// @param receiver The address that will receive the deposit
	/// @param amount The amount of collateral to transfer
	/// @param target The Symmio diamond address to deposit into
	function onTransfer(address collateral, address sender, address receiver, uint256 amount, address target) external onlyRole(CALLER_ROLE) {
		if (receiver == address(0)) revert InvalidAddress();
		IERC20(collateral).approve(target, amount);
		IAccountFacet(target).depositFor(receiver, amount);
		emit TransferExecuted(collateral, sender, receiver, amount, target);
	}
}
