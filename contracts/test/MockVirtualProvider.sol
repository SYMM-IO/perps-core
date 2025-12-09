// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import "../interfaces/IVirtualProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISymmioCore {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function rejectWithdrawRequest(address user, uint256 requestId) external;
	function acceptVirtualExternalTransfer(uint256 id) external;
	function virtualDepositFor(address user, uint256 amount) external;
}

contract VirtualProvider is IVirtualProvider {
	address public symmioAddress;
	uint256 public withdrawnAmount;
	ExternalTransferReq public externalTransferData;

	event WithdrawCalled(address sender, WithdrawReceiverPart part, bytes providerData);

	constructor(address _symmioAddress) {
		symmioAddress = _symmioAddress;
	}

	function virtualDepositFor(address symmio, address user, uint256 amount) external {
		ISymmioCore(symmio).virtualDepositFor(user, amount);
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

	function acceptVirtualExternalTransfer(uint256 id) external {
		ISymmioCore(externalTransferData.source).acceptVirtualExternalTransfer(id);
		ISymmioCore(externalTransferData.target).virtualDepositFor(externalTransferData.receiver, externalTransferData.amount);
	}

	function onWithdrawRequest(WithdrawRequest memory withdrawRequest) external override {
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

	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external override {
		require(withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED, "Withdraw not accepted");
		for (uint i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart memory part = withdrawRequest.parts[i];
			if (part.virtualProvider == address(this)) {
				withdrawnAmount += part.amount;
			}
		}
	}

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external override pure {
		// status is checked off-chain in mocks, keep require always true to avoid warnings
		require(true, "");
		withdrawRequest; // silence unused warning
	}

	function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) external override pure {
		require(true, "");
		withdrawRequest;
	}

	function onSpeedUpWithdrawRequest(WithdrawRequest memory withdrawRequest, uint256 _newCooldown) external override pure {
		require(true, "");
		withdrawRequest;
		_newCooldown;
	}

	function onExternalTransfer(ExternalTransferReq memory externalTransfer) external override {
		require(true, "");
		externalTransferData = externalTransfer;
	}

	function onCancelExternalTransfer(uint256 id) external pure override{
		require(true, "");
		id;
	}

}
