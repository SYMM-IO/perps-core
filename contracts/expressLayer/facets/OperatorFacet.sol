// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../core/storages/WithdrawStorage.sol";
import { WithdrawInfo, Status, OptionType } from "../types/WithdrawTypes.sol";
import { RingBuffer } from "../types/ConfigTypes.sol";

import { ISymmio } from "../interfaces/ISymmio.sol";

import { LibAccessControl } from "../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../libraries/LibCreditLine.sol";
import { LibErrors } from "../libraries/LibErrors.sol";
import { LibParts } from "../libraries/LibParts.sol";
import { LibRingBuffer } from "../libraries/LibRingBuffer.sol";

import { ExpressProviderStorage } from "../storages/ExpressProviderStorage.sol";

/// @title OperatorFacet
/// @notice Bot/operator functions for processing, locking, and unlocking withdrawals.
contract OperatorFacet {
	using LibRingBuffer for RingBuffer;

	event WithdrawProcessed(address indexed user, uint256 indexed requestId);
	event WithdrawLocked(address indexed user, uint256 indexed requestId);
	event WithdrawUnlockedAndProcessed(address indexed user, uint256 indexed requestId);

	modifier nonReentrant() {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (s.reentrancyStatus == 1) revert LibErrors.Reentrancy();
		s.reentrancyStatus = 1;
		_;
		s.reentrancyStatus = 0;
	}

	function processWithdraw(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external nonReentrant {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
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
		} else if (info.optionType == OptionType.INSTANT) {
			processableAt = info.acceptedAt + s.securityWindow;
		} else if (info.optionType == OptionType.SCHEDULED) {
			processableAt = info.availableAt;
		} else {
			processableAt = info.finalizedAt;
		}

		if (!LibAccessControl.hasRole(LibAccessControl.OPERATOR_ROLE, msg.sender)) {
			processableAt += s.tolerancePeriod;
		}
		if (block.timestamp < processableAt) revert LibErrors.TooEarly();

		if (info.optionType != OptionType.STANDARD) {
			LibCreditLine.activate(s.symmio, user, requestId, info);
		}

		_collectAndTransfer(user, requestId, parts, info);
		if (info.optionType != OptionType.STANDARD) {
			_unlockAndDeductPools(info);
		}

		if (info.optionType == OptionType.SCHEDULED) {
			uint256 numBuckets = LibRingBuffer.numBuckets(s.schedulingWindow, s.bucketDuration);
			s.generalRing.sync(s.bucketDuration, s.schedulingWindow, s.configNonce);
			s.generalRing.removeReservedOutflow(info.availableAt, info.generalAmount, s.bucketDuration, numBuckets);

			if (info.affiliateAmount > 0) {
				s.affiliateRings[info.affiliate].sync(s.bucketDuration, s.schedulingWindow, s.configNonce);
				s.affiliateRings[info.affiliate].removeReservedOutflow(info.availableAt, info.affiliateAmount, s.bucketDuration, numBuckets);
			}
		}

		info.status = Status.PROCESSED;
		emit WithdrawProcessed(user, requestId);
	}

	function lockWithdraw(address user, uint256 requestId) external nonReentrant {
		LibAccessControl.enforceRole(LibAccessControl.LOCKER_ROLE);
		WithdrawInfo storage info = ExpressProviderStorage.layout().withdrawInfos[user][requestId];
		if (info.status != Status.ACCEPTED) revert LibErrors.NotAccepted();
		info.status = Status.LOCKED;
		emit WithdrawLocked(user, requestId);
	}

	function unlockAndProcess(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external nonReentrant {
		LibAccessControl.enforceRole(LibAccessControl.UNLOCK_ROLE);
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		WithdrawInfo storage info = s.withdrawInfos[user][requestId];

		if (info.status != Status.LOCKED) revert LibErrors.NotLocked();
		if (info.optionType == OptionType.STANDARD && info.finalizedAt == 0) revert LibErrors.NotFinalized();
		if (keccak256(abi.encode(parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		if (info.optionType != OptionType.STANDARD) {
			LibCreditLine.activate(s.symmio, user, requestId, info);
		}

		_collectAndTransfer(user, requestId, parts, info);
		if (info.optionType != OptionType.STANDARD) {
			_unlockAndDeductPools(info);
		}

		if (info.optionType == OptionType.SCHEDULED) {
			uint256 numBuckets = LibRingBuffer.numBuckets(s.schedulingWindow, s.bucketDuration);
			s.generalRing.sync(s.bucketDuration, s.schedulingWindow, s.configNonce);
			s.generalRing.removeReservedOutflow(info.availableAt, info.generalAmount, s.bucketDuration, numBuckets);

			if (info.affiliateAmount > 0) {
				s.affiliateRings[info.affiliate].sync(s.bucketDuration, s.schedulingWindow, s.configNonce);
				s.affiliateRings[info.affiliate].removeReservedOutflow(info.availableAt, info.affiliateAmount, s.bucketDuration, numBuckets);
			}
		}

		info.status = Status.PROCESSED;
		emit WithdrawUnlockedAndProcessed(user, requestId);
	}

	function _collectAndTransfer(address user, uint256 requestId, WithdrawReceiverPart[] memory parts, WithdrawInfo storage info) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		uint256 operatorFee = s.operatorFees[user][requestId];
		uint256 totalFee = info.fee + operatorFee;
		uint256 userFee = totalFee - info.sponsorCoverage;

		if (info.fee > 0) {
			s.collectedFees[info.affiliate] += info.fee;
		}
		if (operatorFee > 0) {
			s.collectedOperatorFees[info.affiliate] += operatorFee;
		}

		LibParts.transferToReceivers(parts, userFee);
	}

	function _unlockAndDeductPools(WithdrawInfo storage info) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();

		if (info.optionType == OptionType.INSTANT || info.optionType == OptionType.IMMEDIATE) {
			s.lockedGeneralBalance -= info.generalAmount;
			if (info.affiliateAmount > 0) {
				s.lockedAffiliateBalances[info.affiliate] -= info.affiliateAmount;
			}
		}

		s.generalBalance -= info.generalAmount;
		if (info.affiliateAmount > 0) {
			s.affiliateBalances[info.affiliate] -= info.affiliateAmount;
		}
	}
}
