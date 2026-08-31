// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GaslessWallet
/// @notice Deterministic per-owner wallet controlled only by GaslessLayer. It doubles as the
///         user's bridged-deposit address: collateral is bridged to this contract's CREATE2 address
///         (which may be undeployed at the time) and the gateway later sweeps it via `sweepTokenBalance`.
/// @dev The bytecode defines every derived deposit/wallet address and is treated as frozen. Changing
///      it would move every user's address. `gateway` is the deployer (the GaslessLayer proxy) and
///      the only address allowed to act.
contract GaslessWallet {
	using SafeERC20 for IERC20;

	// ─────────────────────────── Types ────────────────────────────

	struct Call {
		address target;
		uint256 value;
		bytes data;
	}

	// ─────────────────────────── State ────────────────────────────

	address public immutable gateway;

	// ────────────────────────── Errors ────────────────────────────

	error CallerNotGateway(address caller);
	error WalletCallFailed(uint256 index, bytes reason);
	error NativeTransferFailed(address recipient, uint256 amount);

	// ─────────────────────── Initialization ───────────────────────

	constructor() {
		gateway = msg.sender;
	}

	// ─────────────────────────── Receive ──────────────────────────

	receive() external payable {}

	// ─────────────────────── Gateway Actions ──────────────────────

	function execute(Call[] calldata calls) external payable onlyGateway returns (bytes[] memory results) {
		results = new bytes[](calls.length);
		for (uint256 i = 0; i < calls.length; i++) {
			(bool ok, bytes memory result) = calls[i].target.call{ value: calls[i].value }(calls[i].data);
			if (!ok) revert WalletCallFailed(i, result);
			results[i] = result;
		}
	}

	/// @notice Transfers `token` (or native when `token` is address(0)) to `recipient`.
	function transfer(address token, address recipient, uint256 amount) external onlyGateway {
		if (token == address(0)) {
			(bool ok, ) = recipient.call{ value: amount }("");
			if (!ok) revert NativeTransferFailed(recipient, amount);
		} else {
			IERC20(token).safeTransfer(recipient, amount);
		}
	}

	/// @notice Transfer this wallet's entire `token` balance to `recipient`. Gateway-only.
	/// @dev Used to sweep bridged deposits and to recover non-collateral tokens.
	/// @return amount The amount transferred.
	function sweepTokenBalance(address token, address recipient) external onlyGateway returns (uint256 amount) {
		amount = IERC20(token).balanceOf(address(this));
		if (amount > 0) {
			IERC20(token).safeTransfer(recipient, amount);
		}
	}

	// ─────────────────────── Access Control ───────────────────────

	modifier onlyGateway() {
		if (msg.sender != gateway) revert CallerNotGateway(msg.sender);
		_;
	}
}
