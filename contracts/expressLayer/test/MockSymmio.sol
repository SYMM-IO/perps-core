// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../core/storages/WithdrawStorage.sol";

/// @notice Minimal mock of SYMMIO core for testing provider contracts.
/// Tracks request-local advanced amounts and simulates the withdrawal lifecycle callbacks.
contract ExpressLayerMockSymmio {
	address public collateral;

	mapping(address => bool) public registeredExpressProviders;
	mapping(address => uint256) public lastWithdrawRequestId;
	mapping(address => mapping(uint256 => WithdrawRequest)) private _withdrawRequests;
	mapping(address => mapping(uint256 => bool)) public acceptedRequests;
	mapping(address => mapping(uint256 => bool)) public rejectedRequests;
	mapping(address => mapping(uint256 => bool)) public cancelAccepted;
	mapping(address => mapping(uint256 => uint256)) public advancedAmounts;
	mapping(address => mapping(uint256 => uint256)) public expressAmounts;

	uint256 public withdrawCooldownPeriod = 12 hours;
	mapping(address => uint256) public deallocateTimestamp;
	mapping(address => uint256) public userNonces;

	constructor(address _collateral) {
		collateral = _collateral;
	}

	function getCollateral() external view returns (address) {
		return collateral;
	}

	function getUserNonce(address user) external view returns (uint256) {
		return userNonces[user];
	}

	function setUserNonce(address user, uint256 nonce) external {
		userNonces[user] = nonce;
	}

	function registerExpressProvider(address provider) external {
		registeredExpressProviders[provider] = true;
	}

	function acceptWithdrawRequest(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		require(req.provider == msg.sender, "Not the provider");
		require(req.status == WithdrawStatus.PENDING, "Not pending");
		req.status = WithdrawStatus.PROVIDER_ACCEPTED;
		acceptedRequests[user][requestId] = true;
	}

	function rejectWithdrawRequest(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		require(req.provider == msg.sender, "Not the provider");
		require(req.status == WithdrawStatus.PENDING, "Not pending");
		req.status = WithdrawStatus.PROVIDER_REJECTED;
		rejectedRequests[user][requestId] = true;
	}

	function acceptWithdrawCancelRequest(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		require(req.provider == msg.sender, "Not the provider");
		req.status = WithdrawStatus.CANCELLED;
		cancelAccepted[user][requestId] = true;
	}

	function advanceWithdraw(address user, uint256 requestId, uint256 amount) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		require(req.provider == msg.sender, "Not the provider");
		require(req.status == WithdrawStatus.PROVIDER_ACCEPTED, "Not accepted");
		require(advancedAmounts[user][requestId] + amount <= expressAmounts[user][requestId], "Advance exceeds express");

		advancedAmounts[user][requestId] += amount;
		IERC20(collateral).transfer(msg.sender, amount);
	}

	function finalizeWithdrawRequest(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		require(req.status == WithdrawStatus.PROVIDER_ACCEPTED || req.status == WithdrawStatus.CANCEL_REQUESTED, "Not accepted");
		require(block.timestamp >= req.cooldownEndTime, "Cooldown not over");

		uint256 remainingExpressAmount = expressAmounts[user][requestId] - advancedAmounts[user][requestId];
		if (remainingExpressAmount > 0) {
			IERC20(collateral).transfer(req.provider, remainingExpressAmount);
		}

		req.status = WithdrawStatus.COMPLETED;

		(bool success, bytes memory ret) = req.provider.call(
			abi.encodeWithSignature(
				"onWithdrawComplete((uint256,address,(uint256,uint256,int256,bytes,address,address)[],uint256,uint256,uint8,bool,bool,address,bool,bytes,uint256,uint256,uint256))",
				req
			)
		);
		if (!success) {
			assembly {
				revert(add(ret, 32), mload(ret))
			}
		}
	}

	function setDeallocateTimestamp(address user, uint256 ts) external {
		deallocateTimestamp[user] = ts;
	}

	function mockInitiateWithdraw(address user, WithdrawReceiverPart[] memory parts, bytes memory providerData) external returns (uint256 requestId) {
		address provider;
		uint256 totalAmount;
		uint256 totalExpressAmount;

		for (uint256 i = 0; i < parts.length; i++) {
			totalAmount += parts[i].amount;
			if (parts[i].expressProvider != address(0)) {
				provider = parts[i].expressProvider;
				totalExpressAmount += parts[i].amount;
			}
		}

		require(provider != address(0), "No express provider");
		require(registeredExpressProviders[provider], "Unregistered express provider");

		requestId = ++lastWithdrawRequestId[user];

		uint256 cooldownEndTime = deallocateTimestamp[user] + withdrawCooldownPeriod;
		if (cooldownEndTime < block.timestamp) {
			cooldownEndTime = block.timestamp;
		}

		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		req.id = requestId;
		req.user = user;
		req.timestamp = block.timestamp;
		req.cooldownEndTime = cooldownEndTime;
		req.status = WithdrawStatus.PENDING;
		req.provider = provider;
		req.isPureVirtual = false;
		req.providerData = providerData;
		req.totalAmount = totalAmount;
		req.totalVirtualAmount = 0;

		expressAmounts[user][requestId] = totalExpressAmount;

		for (uint256 i = 0; i < parts.length; i++) {
			req.parts.push(parts[i]);
		}

		(bool success, bytes memory ret) = provider.call(
			abi.encodeWithSignature(
				"onWithdrawRequest((uint256,address,(uint256,uint256,int256,bytes,address,address)[],uint256,uint256,uint8,bool,bool,address,bool,bytes,uint256,uint256,uint256),address)",
				req,
				collateral
			)
		);
		if (!success) {
			assembly {
				revert(add(ret, 32), mload(ret))
			}
		}
	}

	function mockCancelWithdraw(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		require(req.status == WithdrawStatus.PENDING || req.status == WithdrawStatus.PROVIDER_ACCEPTED, "Invalid status");

		if (req.status == WithdrawStatus.PENDING) {
			req.status = WithdrawStatus.CANCELLED;
			return;
		}

		req.status = WithdrawStatus.CANCEL_REQUESTED;
		(bool success, bytes memory ret) = req.provider.call(
			abi.encodeWithSignature(
				"onWithdrawCancelRequest((uint256,address,(uint256,uint256,int256,bytes,address,address)[],uint256,uint256,uint8,bool,bool,address,bool,bytes,uint256,uint256,uint256))",
				req
			)
		);
		if (!success) {
			assembly {
				revert(add(ret, 32), mload(ret))
			}
		}
	}

	function mockSuspendWithdraw(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		req.status = WithdrawStatus.SUSPENDED;

		(bool success, bytes memory ret) = req.provider.call(
			abi.encodeWithSignature(
				"onWithdrawSuspend((uint256,address,(uint256,uint256,int256,bytes,address,address)[],uint256,uint256,uint8,bool,bool,address,bool,bytes,uint256,uint256,uint256))",
				req
			)
		);
		if (!success) {
			assembly {
				revert(add(ret, 32), mload(ret))
			}
		}
	}

	function mockForceCancelWithdraw(address user, uint256 requestId) external {
		WithdrawRequest storage req = _withdrawRequests[user][requestId];
		req.status = WithdrawStatus.CANCELLED;

		(bool success, bytes memory ret) = req.provider.call(
			abi.encodeWithSignature(
				"onForceWithdrawCancel((uint256,address,(uint256,uint256,int256,bytes,address,address)[],uint256,uint256,uint8,bool,bool,address,bool,bytes,uint256,uint256,uint256))",
				req
			)
		);
		if (!success) {
			assembly {
				revert(add(ret, 32), mload(ret))
			}
		}
	}

	function getWithdrawRequest(address user, uint256 requestId) external view returns (WithdrawRequest memory) {
		return _withdrawRequests[user][requestId];
	}
}
