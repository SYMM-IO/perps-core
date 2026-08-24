// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockWalletTarget {
	using SafeERC20 for IERC20;

	address public lastCaller;
	address public lastToken;
	address public lastRecipient;
	uint256 public lastAmount;
	bytes32 public lastMarker;

	event MockBridge(address indexed caller, address indexed token, address indexed recipient, uint256 amount);

	function bridgeToken(address token, address recipient, uint256 amount) external {
		lastCaller = msg.sender;
		lastToken = token;
		lastRecipient = recipient;
		lastAmount = amount;
		IERC20(token).safeTransferFrom(msg.sender, recipient, amount);
		emit MockBridge(msg.sender, token, recipient, amount);
	}

	function record(bytes32 marker) external payable {
		lastCaller = msg.sender;
		lastMarker = marker;
	}

	function forceRevert() external pure {
		revert("MockWalletTarget: forced");
	}

	receive() external payable {}
}
