// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import "../interfaces/IVirtualProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISymmioCore {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function rejectWithdrawRequest(address user, uint256 requestId) external;
}

contract VirtualProvider is IVirtualProvider {
	address public symmioAddress;
	uint256 public withdrawnAmount;

	event WithdrawCalled(address sender, WithdrawReceiverPart part, bytes providerData);

	constructor(address _symmioAddress) {
		symmioAddress = _symmioAddress;
	}

	function acceptWithdrawRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).acceptWithdrawRequest(user, requestId);
	}

	function acceptWithdrawCancelRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).acceptWithdrawCancelRequest(user, requestId);
	}

	function rejectWithdrawRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).rejectWithdrawRequest(user, requestId);
	}

	function onWithdrawRequest(WithdrawRequest memory withdrawRequest) external {
		bool isVirtualProvider = false;
		for (uint i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart memory part = withdrawRequest.parts[i];
			if (part.expressProvider == address(0) && part.virtualProvider == address(this)) {
				emit WithdrawCalled(msg.sender, part, withdrawRequest.providerData);
				isVirtualProvider = true;
			}
		}
		require(isVirtualProvider, "No parts for this virtual provider");
	}
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external {
		require(withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED, "Withdraw not accepted");
		for (uint i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart memory part = withdrawRequest.parts[i];
			if (part.virtualProvider == address(this)) {
				withdrawnAmount += part.amount;
			}
		}
	}

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external {
		require(withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED, "Withdraw not cancel requested");
	}

	function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) external {
		require(withdrawRequest.status == WithdrawStatus.CANCELLED, "Withdraw not cancel requested");
	}

	function onSpeedUpWithdrawRequest(WithdrawRequest memory withdrawRequest, uint256 newCooldown) external{
		require(withdrawRequest.speedUp, "speed up not requested");
	}

}
