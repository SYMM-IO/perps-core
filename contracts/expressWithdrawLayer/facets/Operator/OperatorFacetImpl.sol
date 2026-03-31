// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";
import { WithdrawInfo, Status, OptionType } from "../../types/WithdrawTypes.sol";

import { ISymmio } from "../../interfaces/ISymmio.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";
import { LibParts } from "../../libraries/LibParts.sol";

import { ExpressProviderStorage } from "../../storages/ExpressProviderStorage.sol";

library OperatorFacetImpl {
	function processWithdraw(address user, uint256 requestId, WithdrawReceiverPart[] memory parts) internal {
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

		info.status = Status.PROCESSED;
	}

	function lockWithdraw(address user, uint256 requestId) internal {
		LibAccessControl.enforceRole(LibAccessControl.LOCKER_ROLE);
		WithdrawInfo storage info = ExpressProviderStorage.layout().withdrawInfos[user][requestId];
		if (info.status != Status.ACCEPTED) revert LibErrors.NotAccepted();
		info.status = Status.LOCKED;
	}

	function unlockAndProcess(address user, uint256 requestId, WithdrawReceiverPart[] memory parts) internal {
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

		info.status = Status.PROCESSED;
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

		s.lockedGeneralBalance -= info.generalAmount;
		if (info.affiliateAmount > 0) {
			s.lockedAffiliateBalances[info.affiliate] -= info.affiliateAmount;
		}

		s.generalBalance -= info.generalAmount;
		if (info.affiliateAmount > 0) {
			s.affiliateBalances[info.affiliate] -= info.affiliateAmount;
		}
	}
}
