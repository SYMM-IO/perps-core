// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { SponsorConfig } from "../../types/ConfigTypes.sol";
import { CreditData } from "../../types/CreditTypes.sol";
import { DecodedOption, ComputedAmounts } from "../../types/OptionTypes.sol";
import { WithdrawReceiverPart, WithdrawRequest } from "../../../core/storages/WithdrawStorage.sol";
import { WithdrawInfo, Status, OptionType } from "../../types/WithdrawTypes.sol";

import { ISymmio } from "../../interfaces/ISymmio.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";
import { LibParts } from "../../libraries/LibParts.sol";

import { ExpressProviderStorage } from "../../storages/ExpressProviderStorage.sol";

library SymmioHookFacetImpl {
	/// @notice Processes a new withdraw request: decodes/verifies the option, locks funds, accepts the request.
	/// @return optionType The option type for event emission.
	/// @return processed Whether the withdraw was immediately processed (IMMEDIATE mode).
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest) internal returns (uint8 optionType, bool processed) {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (msg.sender != s.symmio) revert LibErrors.OnlySymmio();

		(bytes memory optionData, bytes memory validatorData, bytes memory creditDataRaw) = abi.decode(
			withdrawRequest.providerData,
			(bytes, bytes, bytes)
		);

		DecodedOption memory opt = _decodeAndVerifyOption(withdrawRequest, optionData);
		if (opt.optionType > uint8(OptionType.STANDARD)) revert LibErrors.InvalidOptionType();

		OptionType optType = OptionType(opt.optionType);
		if (optType == OptionType.STANDARD && opt.creditAmount > 0) revert LibErrors.CreditNotSupportedForStandard();

		ComputedAmounts memory amounts = LibParts.computeAmounts(withdrawRequest.parts, opt.affiliateAmount, opt.creditAmount);

		uint256 minSigs = _getMinValidatorSignatures(s, opt.affiliate);
		if (optType == OptionType.IMMEDIATE && minSigs == 0) {
			revert LibErrors.ValidatorsRequiredForImmediate();
		}

		uint256 feeBasis = amounts.expressAmount;
		if (opt.fee != (feeBasis * s.affiliateConfigs[opt.affiliate].feeRate) / 10000) revert LibErrors.FeeMismatch();
		if (opt.operatorFee != s.affiliateConfigs[opt.affiliate].operatorFee) revert LibErrors.OperatorFeeMismatch();
		if (opt.fee + opt.operatorFee > feeBasis) revert LibErrors.FeesExceedExpressAmount();

		if (minSigs > 0) {
			_validateValidators(opt.affiliate, withdrawRequest.user, opt.nonce, amounts.expressAmount, validatorData);
		}

		if (optType != OptionType.STANDARD) {
			_lockFunds(opt, amounts);
		}

		if (opt.creditAmount > 0) {
			LibCreditLine.reserveDebt(
				opt.affiliate,
				withdrawRequest.user,
				withdrawRequest.id,
				opt.creditAmount,
				abi.decode(creditDataRaw, (CreditData))
			);
		}

		WithdrawInfo storage info = s.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		info.optionType = optType;
		info.availableAt = opt.availableAt;
		info.expressAmount = amounts.expressAmount;
		info.generalAmount = amounts.generalAmount;
		info.affiliateAmount = opt.affiliateAmount;
		info.creditAmount = opt.creditAmount;
		info.affiliate = opt.affiliate;
		info.acceptedAt = block.timestamp;
		info.cooldownEndTime = withdrawRequest.cooldownEndTime;
		info.partsHash = keccak256(abi.encode(withdrawRequest.parts));
		info.fee = opt.fee;

		if (opt.operatorFee > 0) {
			s.operatorFees[withdrawRequest.user][withdrawRequest.id] = opt.operatorFee;
		}

		_lockFee(withdrawRequest.user, withdrawRequest.id, info);

		uint256 totalFee = opt.fee + opt.operatorFee;
		uint256 actualUserFee = totalFee - info.sponsorCoverage;
		if (actualUserFee > opt.maxUserFee) revert LibErrors.UserFeeExceedsMaximum();

		ISymmio(s.symmio).acceptWithdrawRequest(withdrawRequest.user, withdrawRequest.id);
		optionType = opt.optionType;

		if (optType == OptionType.IMMEDIATE) {
			LibCreditLine.activate(s.symmio, withdrawRequest.user, withdrawRequest.id, info);
			_collectAndTransfer(withdrawRequest.user, withdrawRequest.id, withdrawRequest.parts, info);
			_unlockAndDeductPools(info);
			info.status = Status.PROCESSED;
			processed = true;
		} else {
			info.status = Status.ACCEPTED;
			processed = false;
		}
	}

	/// @notice Handles withdraw completion callback from Symmio.
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (msg.sender != s.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = s.withdrawInfos[withdrawRequest.user][withdrawRequest.id];

		if (info.optionType == OptionType.STANDARD) {
			if (info.status != Status.ACCEPTED && info.status != Status.LOCKED) {
				revert LibErrors.InvalidStatusForStandard();
			}

			info.finalizedAt = block.timestamp;
			if (info.status == Status.ACCEPTED) {
				info.status = Status.FINALIZED;
			}
		} else {
			if (info.status != Status.PROCESSED) revert LibErrors.NotProcessed();

			s.generalBalance += info.generalAmount;
			if (info.affiliateAmount > 0) {
				s.affiliateBalances[info.affiliate] += info.affiliateAmount;
			}

			LibCreditLine.settle(withdrawRequest.user, withdrawRequest.id, info);
			info.status = Status.FINALIZED;
		}
	}

	/// @notice Handles withdraw cancel request callback from Symmio.
	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (msg.sender != s.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = s.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		if (info.status != Status.ACCEPTED) revert LibErrors.NotAccepted();
		if (keccak256(abi.encode(withdrawRequest.parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		_releaseWithdraw(withdrawRequest.user, withdrawRequest.id, info);
		info.status = Status.CANCELLED;

		ISymmio(s.symmio).acceptWithdrawCancelRequest(withdrawRequest.user, withdrawRequest.id);
	}

	/// @notice Handles force withdraw cancel callback from Symmio.
	/// @return cancelled Whether the status ended as CANCELLED (true) vs other terminal states.
	/// @return wasProcessed Whether the withdraw had been in PROCESSED status (rollback path).
	function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) internal returns (bool cancelled, bool wasProcessed) {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (msg.sender != s.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = s.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		if (keccak256(abi.encode(withdrawRequest.parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		if (info.status == Status.PROCESSED) {
			_handleProcessedRollback(withdrawRequest.user, withdrawRequest.id, info);
			info.status = Status.CANCELLED;
			cancelled = true;
			wasProcessed = true;
			return (cancelled, wasProcessed);
		}

		if (info.status != Status.ACCEPTED && info.status != Status.LOCKED) {
			revert LibErrors.InvalidStatusForForceCancel();
		}
		if (info.optionType == OptionType.STANDARD && info.finalizedAt != 0) {
			revert LibErrors.InvalidStatusForForceCancel();
		}

		_releaseWithdraw(withdrawRequest.user, withdrawRequest.id, info);
		info.status = Status.CANCELLED;
		cancelled = true;
		wasProcessed = false;
	}

	/// @notice Handles withdraw suspend callback from Symmio.
	/// @return wasProcessed Whether the withdraw had been in PROCESSED status (rollback path).
	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) internal returns (bool wasProcessed) {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (msg.sender != s.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = s.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		if (keccak256(abi.encode(withdrawRequest.parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		if (info.status == Status.PROCESSED) {
			_handleProcessedRollback(withdrawRequest.user, withdrawRequest.id, info);
			info.status = Status.SUSPENDED;
			wasProcessed = true;
			return wasProcessed;
		}

		if (info.status != Status.ACCEPTED && info.status != Status.LOCKED) {
			revert LibErrors.InvalidStatusForSuspend();
		}
		if (info.optionType == OptionType.STANDARD && info.finalizedAt != 0) {
			revert LibErrors.InvalidStatusForSuspend();
		}

		_releaseWithdraw(withdrawRequest.user, withdrawRequest.id, info);
		info.status = Status.SUSPENDED;
		wasProcessed = false;
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     INTERNAL: OPTION VERIFICATION
	// ═══════════════════════════════════════════════════════════════════

	function _decodeAndVerifyOption(WithdrawRequest memory withdrawRequest, bytes memory optionData) internal returns (DecodedOption memory opt) {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();

		(
			opt.nonce,
			opt.optionType,
			opt.availableAt,
			opt.affiliate,
			opt.affiliateAmount,
			opt.creditAmount,
			opt.fee,
			opt.operatorFee,
			opt.maxUserFee,
			opt.deadline,
			opt.signature
		) = abi.decode(optionData, (uint256, uint8, uint256, address, uint256, uint256, uint256, uint256, uint256, uint256, bytes));

		if (block.timestamp > opt.deadline) revert LibErrors.OptionExpired();
		if (s.nonces[withdrawRequest.user] != opt.nonce) revert LibErrors.InvalidNonce();

		_verifyOptionSignature(withdrawRequest, opt);
		s.nonces[withdrawRequest.user]++;
	}

	function _verifyOptionSignature(WithdrawRequest memory withdrawRequest, DecodedOption memory opt) internal view {
		bytes32 partsHash = keccak256(abi.encode(withdrawRequest.parts));
		bytes32 structHash = keccak256(
			abi.encode(
				LibAccessControl.WITHDRAW_OPTION_TYPEHASH,
				withdrawRequest.user,
				opt.nonce,
				opt.optionType,
				opt.availableAt,
				opt.affiliate,
				opt.affiliateAmount,
				opt.creditAmount,
				opt.fee,
				opt.operatorFee,
				opt.maxUserFee,
				partsHash,
				opt.deadline
			)
		);

		address signer = ECDSA.recover(LibAccessControl.hashTypedDataV4(structHash), opt.signature);
		if (!LibAccessControl.hasRole(LibAccessControl.SIGNER_ROLE, signer)) revert LibErrors.InvalidSigner();
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     INTERNAL: FUND LOCKING
	// ═══════════════════════════════════════════════════════════════════

	function _lockFunds(DecodedOption memory opt, ComputedAmounts memory amounts) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();

		if (s.generalBalance - s.lockedGeneralBalance < amounts.generalAmount) revert LibErrors.InsufficientGeneralBalance();
		if (s.affiliateBalances[opt.affiliate] - s.lockedAffiliateBalances[opt.affiliate] < opt.affiliateAmount) {
			revert LibErrors.InsufficientAffiliateBalance();
		}

		s.lockedGeneralBalance += amounts.generalAmount;
		s.lockedAffiliateBalances[opt.affiliate] += opt.affiliateAmount;
	}

	function _lockFee(address user, uint256 requestId, WithdrawInfo storage info) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();

		uint256 totalFee = info.fee + s.operatorFees[user][requestId];
		if (totalFee == 0) return;

		uint256 sponsorBal = s.sponsorBalances[info.affiliate];
		if (sponsorBal == 0) return;

		SponsorConfig storage config = s.sponsorConfigs[info.affiliate];
		uint256 feeBearingAmount = info.expressAmount;
		if (config.maxWithdrawAmount > 0 && feeBearingAmount > config.maxWithdrawAmount) return;

		uint256 maxCoverage = totalFee;
		if (config.maxFeePerWithdraw > 0 && maxCoverage > config.maxFeePerWithdraw) {
			maxCoverage = config.maxFeePerWithdraw;
		}

		uint256 sponsorCoverage = sponsorBal < maxCoverage ? sponsorBal : maxCoverage;
		if (sponsorCoverage > 0) {
			s.sponsorBalances[info.affiliate] -= sponsorCoverage;
			info.sponsorCoverage = sponsorCoverage;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     INTERNAL: VALIDATORS
	// ═══════════════════════════════════════════════════════════════════

	function _validateValidators(address affiliate, address user, uint256 nonce, uint256 amount, bytes memory validatorData) internal view {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		(bytes[] memory signatures, uint256[] memory timestamps, uint256 symmioNonce) = abi.decode(validatorData, (bytes[], uint256[], uint256));

		if (signatures.length != timestamps.length) revert LibErrors.ArrayLengthMismatch();

		uint256 minSigs = _getMinValidatorSignatures(s, affiliate);
		if (signatures.length < minSigs) revert LibErrors.InsufficientValidatorSignatures();
		if (ISymmio(s.symmio).nonceOfPartyA(user) != symmioNonce) revert LibErrors.InvalidNonce();

		uint256 timeout = _getValidatorApprovalTimeout(s, affiliate);
		address lastSigner = address(0);
		for (uint256 i = 0; i < signatures.length; i++) {
			if (timestamps[i] > block.timestamp || block.timestamp - timestamps[i] > timeout) {
				revert LibErrors.ValidatorApprovalExpired();
			}

			bytes32 structHash = keccak256(abi.encode(LibAccessControl.VALIDATOR_APPROVAL_TYPEHASH, user, nonce, amount, timestamps[i], symmioNonce));
			address signer = ECDSA.recover(LibAccessControl.hashTypedDataV4(structHash), signatures[i]);

			if (!_isValidator(s, affiliate, signer)) revert LibErrors.InvalidValidator();
			if (signer <= lastSigner) revert LibErrors.DuplicateValidator();
			lastSigner = signer;
		}
	}

	/// @dev Returns the minValidatorSignatures for the affiliate, falling back to address(0) default.
	function _getMinValidatorSignatures(ExpressProviderStorage.Layout storage s, address affiliate) internal view returns (uint256) {
		uint256 v = s.minValidatorSignatures[affiliate];
		if (v > 0) return v;
		return s.minValidatorSignatures[address(0)];
	}

	/// @dev Returns the validatorApprovalTimeout for the affiliate, falling back to address(0) default.
	function _getValidatorApprovalTimeout(ExpressProviderStorage.Layout storage s, address affiliate) internal view returns (uint256) {
		uint256 v = s.validatorApprovalTimeout[affiliate];
		if (v > 0) return v;
		return s.validatorApprovalTimeout[address(0)];
	}

	/// @dev Returns true if signer is a validator for the affiliate or the default (address(0)).
	function _isValidator(ExpressProviderStorage.Layout storage s, address affiliate, address signer) internal view returns (bool) {
		return s.validators[affiliate][signer] || s.validators[address(0)][signer];
	}

	// ═══════════════════════════════════════════════════════════════════
	//                  INTERNAL: COLLECT, TRANSFER, RELEASE
	// ═══════════════════════════════════════════════════════════════════

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

	function _releaseWithdraw(address user, uint256 requestId, WithdrawInfo storage info) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();

		if (info.sponsorCoverage > 0) {
			s.sponsorBalances[info.affiliate] += info.sponsorCoverage;
			info.sponsorCoverage = 0;
		}

		if (info.optionType == OptionType.INSTANT || info.optionType == OptionType.IMMEDIATE) {
			s.lockedGeneralBalance -= info.generalAmount;
			if (info.affiliateAmount > 0) {
				s.lockedAffiliateBalances[info.affiliate] -= info.affiliateAmount;
			}
		}

		LibCreditLine.releaseReservation(user, requestId, info);
	}

	function _handleProcessedRollback(address user, uint256 requestId, WithdrawInfo storage info) internal {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (info.optionType == OptionType.STANDARD) revert LibErrors.InvalidPostPayoutRollback();

		LibCreditLine.coverLoss(s.collateral, s.symmio, user, requestId, info);
	}
}
