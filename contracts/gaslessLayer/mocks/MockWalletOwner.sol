// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Test contract owner that can attempt a gateway callback while receiving a withdrawal.
contract MockWalletOwner {
	address public immutable gateway;
	bytes public callback;
	bool public callbackSucceeded;
	bytes public callbackResult;

	constructor(address gateway_) {
		gateway = gateway_;
	}

	function setCallback(bytes calldata data) external {
		callback = data;
	}

	function callGateway(bytes calldata data) external returns (bytes memory result) {
		bool success;
		(success, result) = gateway.call(data);
		require(success, "MockWalletOwner: call failed");
	}

	receive() external payable {
		if (callback.length > 0) (callbackSucceeded, callbackResult) = gateway.call(callback);
	}
}
