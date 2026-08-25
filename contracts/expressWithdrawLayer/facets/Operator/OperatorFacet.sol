// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";
import { WithdrawInfo, Status, OptionType } from "../../types/WithdrawTypes.sol";

import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IOperatorFacet } from "./IOperatorFacet.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";
import { LibParts } from "../../libraries/LibParts.sol";

import { GlobalStorage } from "../../storages/GlobalStorage.sol";
import { PoolStorage } from "../../storages/PoolStorage.sol";
import { FeeStorage } from "../../storages/FeeStorage.sol";

import { Pausable } from "../../utils/Pausable.sol";
import { ReentrancyGuard } from "../../utils/ReentrancyGuard.sol";

/// @title OperatorFacet
/// @notice Bot/operator functions for processing, locking, and unlocking withdrawals.
contract OperatorFacet is IOperatorFacet, Pausable, ReentrancyGuard {
	function processWithdraw(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external nonReentrant whenNotPaused {
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		if (ISymmio(s.symmio).isSuspended(user)) revert LibErrors.UserSuspended();
		WithdrawInfo storage info = s.withdrawInfos[user][requestId];

		bool isLockedAfterCooldown = info.status == Status.LOCKED && block.timestamp >= info.cooldownEndTime;

		if (info.optionType == OptionType.STANDARD) {
			if (isLockedAfterCooldown && info.finalizedAt == 0) {
				ISymmio(s.symmio).finalizeWithdrawRequest(user, requestId);
			}
			if (info.status != Status.FINALIZED && !isLockedAfterCooldown) revert LibErrors.NotFinalized();
		} else {
			if (info.status != Status.ACCEPTED && !isLockedAfterCooldown) revert LibErrors.NotAccepted();
		}

		if (keccak256(abi.encode(parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		uint256 processableAt;
		if (isLockedAfterCooldown) {
			processableAt = info.cooldownEndTime;
		} else if (info.optionType == OptionType.WINDOWED) {
			processableAt = info.acceptedAt + s.securityWindow;
		} else {
			processableAt = info.finalizedAt;
		}

		if (!LibAccessControl.hasRole(LibAccessControl.OPERATOR_ROLE, msg.sender)) {
			processableAt += s.tolerancePeriod;
		}
		if (block.timestamp < processableAt) revert LibErrors.TooEarly();

		if (info.optionType != OptionType.STANDARD) {
			_unlockAndDeductPools(info);
		}
		info.status = Status.PROCESSED;

		if (info.optionType != OptionType.STANDARD) {
			LibCreditLine.activate(s.symmio, user, requestId, info);
		}
		_collectAndTransfer(user, requestId, parts, info);

		emit WithdrawProcessed(user, requestId);
	}

	function lockWithdraw(address user, uint256 requestId) external nonReentrant whenNotPaused {
		LibAccessControl.enforceRole(LibAccessControl.LOCKER_ROLE);
		WithdrawInfo storage info = GlobalStorage.layout().withdrawInfos[user][requestId];
		if (info.status != Status.ACCEPTED) revert LibErrors.NotAccepted();
		info.status = Status.LOCKED;
		emit WithdrawLocked(user, requestId);
	}

	function unlockAndProcess(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external nonReentrant whenNotPaused {
		LibAccessControl.enforceRole(LibAccessControl.UNLOCK_ROLE);
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		if (ISymmio(s.symmio).isSuspended(user)) revert LibErrors.UserSuspended();
		WithdrawInfo storage info = s.withdrawInfos[user][requestId];

		if (info.status != Status.LOCKED) revert LibErrors.NotLocked();
		if (info.optionType == OptionType.STANDARD && info.finalizedAt == 0) revert LibErrors.NotFinalized();
		if (keccak256(abi.encode(parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		if (info.optionType != OptionType.STANDARD) {
			_unlockAndDeductPools(info);
		}
		info.status = Status.PROCESSED;

		if (info.optionType != OptionType.STANDARD) {
			LibCreditLine.activate(s.symmio, user, requestId, info);
		}
		_collectAndTransfer(user, requestId, parts, info);

		emit WithdrawUnlockedAndProcessed(user, requestId);
	}

	function _collectAndTransfer(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts, WithdrawInfo storage info) internal {
		FeeStorage.Layout storage f = FeeStorage.layout();
		uint256 operatorFee = f.operatorFees[user][requestId];
		uint256 affiliateFee = info.fee + info.accelerationFee;
		uint256 userFee = affiliateFee + operatorFee;

		if (info.optionType == OptionType.STANDARD) {
			if (affiliateFee > 0) f.collectedFees[info.affiliate] += affiliateFee;
			if (operatorFee > 0) f.collectedOperatorFees[info.affiliate] += operatorFee;
		} else {
			if (affiliateFee > 0) f.pendingFees[user][requestId] = affiliateFee;
			if (operatorFee > 0) f.pendingOperatorFees[user][requestId] = operatorFee;
		}

		LibParts.transferToReceivers(parts, userFee);
	}

	function _unlockAndDeductPools(WithdrawInfo storage info) internal {
		PoolStorage.Layout storage p = PoolStorage.layout();

		p.lockedGeneralBalance -= info.generalAmount;
		if (info.affiliateAmount > 0) {
			p.lockedAffiliateBalances[info.affiliate] -= info.affiliateAmount;
		}

		p.generalBalance -= info.generalAmount;
		if (info.affiliateAmount > 0) {
			p.affiliateBalances[info.affiliate] -= info.affiliateAmount;
		}
	}
}
