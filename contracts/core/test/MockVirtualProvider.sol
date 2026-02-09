// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import { IVirtualProvider } from "../interfaces/IVirtualProvider.sol";
import { WithdrawRequest, WithdrawReceiverPart, WithdrawStatus } from "../storages/WithdrawStorage.sol";
import { VirtualExternalTransferRequest } from "../storages/ExternalTransferStorage.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface ISymmioCore {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function rejectWithdrawRequest(address user, uint256 requestId) external;
	function acceptVirtualExternalTransfer(uint256 id) external;
	function virtualDepositFor(address user, uint256 amount) external;
	function getCollateral() external view returns (address);
}

contract VirtualProvider is IVirtualProvider {
	address public symmioAddress;
	uint256 public withdrawnAmount;
	VirtualExternalTransferRequest public externalTransferData;

	event WithdrawCalled(address sender, WithdrawReceiverPart part, bytes providerData);
	event WithdrawSuspended(address indexed user, uint256 indexed requestId);

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

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external pure override {
		// status is checked off-chain in mocks, keep require always true to avoid warnings
		require(true, "");
		withdrawRequest; // silence unused warning
	}

	function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) external pure override {
		require(true, "");
		withdrawRequest;
	}

	function onSpeedUpWithdrawRequest(WithdrawRequest memory withdrawRequest, uint256 _newCooldown) external pure override {
		require(true, "");
		withdrawRequest;
		_newCooldown;
	}

	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external override {
		emit WithdrawSuspended(withdrawRequest.user, withdrawRequest.id);
	}

	function onExternalTransfer(VirtualExternalTransferRequest memory externalTransfer) external override {
		require(true, "");
		externalTransferData = externalTransfer;
	}

	function onCancelExternalTransfer(uint256 id) external pure override {
		require(true, "");
		id;
	}

	function onExpressDeposit(address user, uint256 amount, address symmioCore) external override {
		uint256 collateralDecimals = IERC20Metadata(ISymmioCore(symmioCore).getCollateral()).decimals();
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** collateralDecimals);

		// Call virtualDepositFor on the Symmio
		ISymmioCore(symmioCore).virtualDepositFor(user, amountWith18Decimals);
	}
}

// Configurable mock for testing failure scenarios
contract ConfigurableMockVirtualProvider is IVirtualProvider {
	enum FailureMode {
		NONE,
		REVERT,
		WRONG_AMOUNT,
		WRONG_USER
	}

	FailureMode public failureMode;
	address public wrongUser;
	int256 public amountDelta; // Can be positive or negative

	function setFailureMode(FailureMode _mode) external {
		failureMode = _mode;
	}

	function setWrongUser(address _user) external {
		wrongUser = _user;
	}

	function setAmountDelta(int256 _delta) external {
		amountDelta = _delta;
	}

	function onExpressDeposit(address user, uint256 amount, address symmioCore) external override {
		if (failureMode == FailureMode.REVERT) {
			revert("ConfigurableMockVirtualProvider: intentional revert");
		}

		uint256 collateralDecimals = IERC20Metadata(ISymmioCore(symmioCore).getCollateral()).decimals();
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** collateralDecimals);

		address targetUser = user;
		uint256 targetAmount = amountWith18Decimals;

		if (failureMode == FailureMode.WRONG_USER) {
			targetUser = wrongUser;
		}

		if (failureMode == FailureMode.WRONG_AMOUNT) {
			if (amountDelta >= 0) {
				targetAmount = amountWith18Decimals + uint256(amountDelta);
			} else {
				targetAmount = amountWith18Decimals - uint256(-amountDelta);
			}
		}

		ISymmioCore(symmioCore).virtualDepositFor(targetUser, targetAmount);
	}

	function onWithdrawRequest(WithdrawRequest memory) external pure override {}
	function onWithdrawComplete(WithdrawRequest memory) external pure override {}
	function onWithdrawCancelRequest(WithdrawRequest memory) external pure override {}
	function onForceWithdrawCancel(WithdrawRequest memory) external pure override {}
	function onSpeedUpWithdrawRequest(WithdrawRequest memory, uint256) external pure override {}
	function onWithdrawSuspend(WithdrawRequest memory) external pure override {}
	function onExternalTransfer(VirtualExternalTransferRequest memory) external pure override {}
	function onCancelExternalTransfer(uint256) external pure override {}
}

interface IAccountLayerDiamond {
	function _call(address account, bytes[] calldata callDatas) external returns (bytes[] memory);
	function getSigner() external view returns (address);
}

// Malicious mock that attempts to exploit the callback by calling back into AccountLayer
contract MaliciousMockVirtualProvider is IVirtualProvider {
	address public accountLayerDiamond;
	address public capturedSigner;
	bool public attackAttempted;
	bool public attackSucceeded;
	bytes public attackRevertReason;

	constructor(address _accountLayerDiamond) {
		accountLayerDiamond = _accountLayerDiamond;
	}

	function onExpressDeposit(address user, uint256 amount, address symmioCore) external override {
		attackAttempted = true;

		// Capture what getSigner() returns during the callback
		// If SafeCall is working, this should return address(0) or msg.sender (this contract)
		// NOT the original user
		capturedSigner = IAccountLayerDiamond(accountLayerDiamond).getSigner();

		// Attempt to call back into AccountLayer to impersonate the user
		// This should fail with NotOwner if signer is properly cleared
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = abi.encodeWithSignature("allocate(uint256)", 1);

		try IAccountLayerDiamond(accountLayerDiamond)._call(user, callDatas) {
			attackSucceeded = true;
		} catch (bytes memory reason) {
			attackSucceeded = false;
			attackRevertReason = reason;
		}

		// Still do the legitimate deposit so the transaction can complete
		uint256 collateralDecimals = IERC20Metadata(ISymmioCore(symmioCore).getCollateral()).decimals();
		uint256 amountWith18Decimals = (amount * 1e18) / (10 ** collateralDecimals);
		ISymmioCore(symmioCore).virtualDepositFor(user, amountWith18Decimals);
	}

	function onWithdrawRequest(WithdrawRequest memory) external pure override {}
	function onWithdrawComplete(WithdrawRequest memory) external pure override {}
	function onWithdrawCancelRequest(WithdrawRequest memory) external pure override {}
	function onForceWithdrawCancel(WithdrawRequest memory) external pure override {}
	function onSpeedUpWithdrawRequest(WithdrawRequest memory, uint256) external pure override {}
	function onWithdrawSuspend(WithdrawRequest memory) external pure override {}
	function onExternalTransfer(VirtualExternalTransferRequest memory) external pure override {}
	function onCancelExternalTransfer(uint256) external pure override {}
}
