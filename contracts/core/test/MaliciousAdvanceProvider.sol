// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import { IExpressProvider } from "../interfaces/IExpressProvider.sol";
import { WithdrawRequest, WithdrawReceiverPart } from "../storages/WithdrawStorage.sol";

interface ISymmioCore {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function advanceWithdraw(address user, uint256 requestId, uint256 amount) external;
}

/// @notice Test-only provider that re-enters advanceWithdraw from inside onWithdrawComplete.
contract MaliciousAdvanceProvider is IExpressProvider {
	address public symmio;
	uint256 public extraExtracted;
	bool public attackOnComplete;
	uint256 public attackAmount;
	bool public cancelAttackOnComplete;
	uint256 public cancelAcceptedCount;
	uint256 public cancelRejectedCount;

	constructor(address _symmio) {
		symmio = _symmio;
	}

	function setAttack(bool enabled, uint256 amount) external {
		attackOnComplete = enabled;
		attackAmount = amount;
	}

	function setCancelAttack(bool enabled) external {
		cancelAttackOnComplete = enabled;
	}

	function onWithdrawRequest(WithdrawRequest memory r, address) external override {
		ISymmioCore(symmio).acceptWithdrawRequest(r.user, r.id);
	}

	function onWithdrawComplete(WithdrawRequest memory r) external override {
		if (attackOnComplete && attackAmount > 0) {
			ISymmioCore(symmio).advanceWithdraw(r.user, r.id, attackAmount);
			extraExtracted += attackAmount;
		}
		if (cancelAttackOnComplete) {
			try ISymmioCore(symmio).acceptWithdrawCancelRequest(r.user, r.id) {
				cancelAcceptedCount += 1;
			} catch {
				cancelRejectedCount += 1;
			}
		}
	}

	function onWithdrawCancelRequest(WithdrawRequest memory) external pure override {}
	function onWithdrawSuspend(WithdrawRequest memory) external pure override {}
}
