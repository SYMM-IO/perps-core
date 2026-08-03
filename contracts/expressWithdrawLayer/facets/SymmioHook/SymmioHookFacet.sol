// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { CreditData } from "../../types/CreditTypes.sol";
import { WithdrawOffer, ComputedAmounts } from "../../types/OptionTypes.sol";
import { WithdrawReceiverPart, WithdrawRequest } from "../../../core/storages/WithdrawStorage.sol";
import { WithdrawInfo, Status, OptionType } from "../../types/WithdrawTypes.sol";

import { ISymmio } from "../../interfaces/ISymmio.sol";
import { ISymmioHookFacet } from "./ISymmioHookFacet.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";
import { LibParts } from "../../libraries/LibParts.sol";

import { GlobalStorage } from "../../storages/GlobalStorage.sol";
import { PoolStorage } from "../../storages/PoolStorage.sol";
import { FeeStorage } from "../../storages/FeeStorage.sol";
import { ValidatorStorage } from "../../storages/ValidatorStorage.sol";

import { Pausable } from "../../utils/Pausable.sol";
import { ReentrancyGuard } from "../../utils/ReentrancyGuard.sol";

/// @title SymmioHookFacet
/// @notice Handles SYMMIO callbacks for the ExpressProvider diamond.
contract SymmioHookFacet is ISymmioHookFacet, Pausable, ReentrancyGuard {
	/// @notice Processes a new withdraw request: decodes/verifies the offer, locks funds, accepts the request.
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address callbackCollateral) external nonReentrant whenNotPaused {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		FeeStorage.Layout storage f = FeeStorage.layout();
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		if (msg.sender != g.symmio) revert LibErrors.OnlySymmio();
		if (withdrawRequest.provider != address(this)) revert LibErrors.InvalidProvider();
		if (callbackCollateral != address(g.collateral)) revert LibErrors.InvalidCollateral();

		(bytes memory offerData, bytes memory validatorData, bytes memory creditDataRaw) = abi.decode(
			withdrawRequest.providerData,
			(bytes, bytes, bytes)
		);

		WithdrawOffer memory offer = _decodeAndVerifyOffer(withdrawRequest, offerData);
		if (offer.optionType > uint8(OptionType.STANDARD)) revert LibErrors.InvalidOptionType();

		OptionType optType = OptionType(offer.optionType);
		if (optType == OptionType.STANDARD && offer.creditAmount > 0) revert LibErrors.CreditNotSupportedForStandard();

		ComputedAmounts memory amounts = LibParts.computeAmounts(withdrawRequest.parts, offer.affiliateAmount, offer.creditAmount);

		uint256 minSigs = _getMinValidatorSignatures(v, offer.affiliate);
		if (optType == OptionType.SAME_TX && minSigs == 0) {
			revert LibErrors.ValidatorsRequiredForSameTx();
		}

		uint256 feeBasis = amounts.expressAmount;
		if (offer.fee != (feeBasis * f.affiliateConfigs[offer.affiliate].feeRate) / 10000) revert LibErrors.FeeMismatch();
		if (offer.operatorFee != f.affiliateConfigs[offer.affiliate].operatorFee) revert LibErrors.OperatorFeeMismatch();
		if (offer.fee > feeBasis || offer.operatorFee > feeBasis - offer.fee) revert LibErrors.FeesExceedExpressAmount();
		uint256 baseFees = offer.fee + offer.operatorFee;

		if (optType != OptionType.STANDARD && minSigs > 0) {
			_validateValidators(offer.affiliate, withdrawRequest.user, offer.nonce, withdrawRequest.totalAmount, validatorData);
		}

		if (optType != OptionType.STANDARD) {
			_lockFunds(offer, amounts);
		}

		if (offer.creditAmount > 0) {
			LibCreditLine.reserveDebt(
				offer.affiliate,
				withdrawRequest.user,
				withdrawRequest.id,
				offer.creditAmount,
				abi.decode(creditDataRaw, (CreditData))
			);
		}

		WithdrawInfo storage info = g.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		if (info.status != Status.NONE) revert LibErrors.StaleWithdrawSlot();
		info.optionType = optType;
		info.availableAt = offer.availableAt;
		info.expressAmount = amounts.expressAmount;
		info.generalAmount = amounts.generalAmount;
		info.affiliateAmount = offer.affiliateAmount;
		info.creditAmount = offer.creditAmount;
		info.affiliate = offer.affiliate;
		info.acceptedAt = block.timestamp;
		info.cooldownEndTime = withdrawRequest.cooldownEndTime;
		info.partsHash = keccak256(abi.encode(withdrawRequest.parts));
		info.fee = offer.fee;
		info.finalizedAt = 0;
		info.maxAccelerationFee = offer.maxAccelerationFee;
		f.operatorFees[withdrawRequest.user][withdrawRequest.id] = offer.operatorFee;

		if (baseFees > offer.maxUserFee) revert LibErrors.UserFeeExceedsMaximum();
		if (optType == OptionType.STANDARD && offer.maxAccelerationFee > feeBasis - baseFees) {
			revert LibErrors.FeesExceedExpressAmount();
		}

		ISymmio(g.symmio).acceptWithdrawRequest(withdrawRequest.user, withdrawRequest.id);

		emit WithdrawAccepted(withdrawRequest.user, withdrawRequest.id, offer.optionType);

		if (optType == OptionType.SAME_TX) {
			_unlockAndDeductPools(info);
			info.status = Status.PROCESSED;
			LibCreditLine.activate(g.symmio, withdrawRequest.user, withdrawRequest.id, info);
			_collectAndTransfer(withdrawRequest.user, withdrawRequest.id, withdrawRequest.parts, info);
			emit WithdrawProcessed(withdrawRequest.user, withdrawRequest.id);
		} else {
			info.status = Status.ACCEPTED;
		}
	}

	/// @notice Handles withdraw completion callback from Symmio.
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		if (msg.sender != g.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = g.withdrawInfos[withdrawRequest.user][withdrawRequest.id];

		if (info.optionType == OptionType.STANDARD) {
			if (info.status != Status.ACCEPTED && info.status != Status.LOCKED) {
				revert LibErrors.InvalidStatusForStandard();
			}
			if (info.finalizedAt != 0) revert LibErrors.InvalidStatusForComplete();

			info.finalizedAt = block.timestamp;
			if (info.status == Status.ACCEPTED) {
				info.status = Status.FINALIZED;
			}
		} else {
			if (info.status != Status.PROCESSED) revert LibErrors.InvalidStatusForComplete();

			PoolStorage.Layout storage p = PoolStorage.layout();
			if (info.generalAmount > 0) {
				p.generalBalance += info.generalAmount;
			}
			if (info.affiliateAmount > 0) {
				p.affiliateBalances[info.affiliate] += info.affiliateAmount;
			}

			FeeStorage.Layout storage f = FeeStorage.layout();
			uint256 pf = f.pendingFees[withdrawRequest.user][withdrawRequest.id];
			uint256 pof = f.pendingOperatorFees[withdrawRequest.user][withdrawRequest.id];
			if (pf > 0) {
				f.collectedFees[info.affiliate] += pf;
				delete f.pendingFees[withdrawRequest.user][withdrawRequest.id];
			}
			if (pof > 0) {
				f.collectedOperatorFees[info.affiliate] += pof;
				delete f.pendingOperatorFees[withdrawRequest.user][withdrawRequest.id];
			}

			LibCreditLine.settle(withdrawRequest.user, withdrawRequest.id, info);
			info.status = Status.FINALIZED;
		}

		emit WithdrawFinalized(withdrawRequest.user, withdrawRequest.id);
	}

	/// @notice Handles withdraw cancel request callback from Symmio.
	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external nonReentrant {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		if (msg.sender != g.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = g.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		if (info.status != Status.ACCEPTED) revert LibErrors.NotAccepted();
		if (keccak256(abi.encode(withdrawRequest.parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		_releaseWithdraw(withdrawRequest.user, withdrawRequest.id, info);
		info.status = Status.CANCELLED;

		ISymmio(g.symmio).acceptWithdrawCancelRequest(withdrawRequest.user, withdrawRequest.id);

		emit WithdrawCancelled(withdrawRequest.user, withdrawRequest.id);
	}

	/// @notice Handles withdraw suspend callback from Symmio.
	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external nonReentrant {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		if (msg.sender != g.symmio) revert LibErrors.OnlySymmio();

		WithdrawInfo storage info = g.withdrawInfos[withdrawRequest.user][withdrawRequest.id];
		if (keccak256(abi.encode(withdrawRequest.parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		if (info.status == Status.PROCESSED) {
			_handleProcessedRollback(withdrawRequest.user, withdrawRequest.id, info);
			info.status = Status.SUSPENDED;
			emit WithdrawSuspended(withdrawRequest.user, withdrawRequest.id);
			return;
		}

		if (info.status != Status.ACCEPTED && info.status != Status.LOCKED) {
			revert LibErrors.InvalidStatusForSuspend();
		}
		if (info.optionType == OptionType.STANDARD && info.finalizedAt != 0) {
			revert LibErrors.InvalidStatusForSuspend();
		}

		_releaseWithdraw(withdrawRequest.user, withdrawRequest.id, info);
		info.status = Status.SUSPENDED;

		emit WithdrawSuspended(withdrawRequest.user, withdrawRequest.id);
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     INTERNAL: OFFER VERIFICATION
	// ═══════════════════════════════════════════════════════════════════

	function _decodeAndVerifyOffer(WithdrawRequest memory withdrawRequest, bytes memory offerData) internal returns (WithdrawOffer memory offer) {
		GlobalStorage.Layout storage g = GlobalStorage.layout();

		(
			offer.nonce,
			offer.optionType,
			offer.availableAt,
			offer.affiliate,
			offer.affiliateAmount,
			offer.creditAmount,
			offer.fee,
			offer.operatorFee,
			offer.maxUserFee,
			offer.maxAccelerationFee,
			offer.deadline,
			offer.signature
		) = abi.decode(offerData, (uint256, uint8, uint256, address, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bytes));

		if (block.timestamp > offer.deadline) revert LibErrors.OfferExpired();
		if (g.nonces[withdrawRequest.user] != offer.nonce) revert LibErrors.InvalidNonce();

		_verifyOfferSignature(withdrawRequest, offer);
		g.nonces[withdrawRequest.user]++;
	}

	function _verifyOfferSignature(WithdrawRequest memory withdrawRequest, WithdrawOffer memory offer) internal view {
		bytes32 partsHash = keccak256(abi.encode(withdrawRequest.parts));
		bytes32 structHash = keccak256(
			abi.encode(
				LibAccessControl.WITHDRAW_OPTION_TYPEHASH,
				withdrawRequest.user,
				offer.nonce,
				offer.optionType,
				offer.availableAt,
				offer.affiliate,
				offer.affiliateAmount,
				offer.creditAmount,
				offer.fee,
				offer.operatorFee,
				offer.maxUserFee,
				offer.maxAccelerationFee,
				partsHash,
				offer.deadline
			)
		);

		address signer = ECDSA.recover(LibAccessControl.hashTypedDataV4(structHash), offer.signature);
		if (!LibAccessControl.hasRole(LibAccessControl.SIGNER_ROLE, signer)) revert LibErrors.InvalidSigner();
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     INTERNAL: FUND LOCKING
	// ═══════════════════════════════════════════════════════════════════

	function _lockFunds(WithdrawOffer memory offer, ComputedAmounts memory amounts) internal {
		PoolStorage.Layout storage p = PoolStorage.layout();

		if (p.generalBalance - p.lockedGeneralBalance < amounts.generalAmount) revert LibErrors.InsufficientGeneralBalance();
		if (p.affiliateBalances[offer.affiliate] - p.lockedAffiliateBalances[offer.affiliate] < offer.affiliateAmount) {
			revert LibErrors.InsufficientAffiliateBalance();
		}

		p.lockedGeneralBalance += amounts.generalAmount;
		p.lockedAffiliateBalances[offer.affiliate] += offer.affiliateAmount;
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     INTERNAL: VALIDATORS
	// ═══════════════════════════════════════════════════════════════════

	function _validateValidators(address affiliate, address user, uint256 nonce, uint256 amount, bytes memory validatorData) internal view {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		(bytes[] memory signatures, uint256[] memory timestamps, uint256 symmioNonce) = abi.decode(validatorData, (bytes[], uint256[], uint256));

		if (signatures.length != timestamps.length) revert LibErrors.ArrayLengthMismatch();

		uint256 minSigs = _getMinValidatorSignatures(v, affiliate);
		if (signatures.length < minSigs) revert LibErrors.InsufficientValidatorSignatures();
		if (ISymmio(g.symmio).nonceOfPartyA(user) != symmioNonce) revert LibErrors.InvalidNonce();

		uint256 timeout = _getValidatorApprovalTimeout(v, affiliate);
		address lastSigner = address(0);
		for (uint256 i = 0; i < signatures.length; i++) {
			if (timestamps[i] > block.timestamp || block.timestamp - timestamps[i] > timeout) {
				revert LibErrors.ValidatorApprovalExpired();
			}

			bytes32 structHash = keccak256(
				abi.encode(LibAccessControl.VALIDATOR_APPROVAL_TYPEHASH, user, nonce, amount, timestamps[i], symmioNonce, g.symmio)
			);
			address signer = ECDSA.recover(LibAccessControl.hashTypedDataV4(structHash), signatures[i]);

			if (!_isValidator(v, affiliate, signer)) revert LibErrors.InvalidValidator();
			if (signer <= lastSigner) revert LibErrors.DuplicateValidator();
			lastSigner = signer;
		}
	}

	/// @dev Returns the minValidatorSignatures for the affiliate, falling back to address(0) default.
	function _getMinValidatorSignatures(ValidatorStorage.Layout storage v, address affiliate) internal view returns (uint256) {
		uint256 val = v.minValidatorSignatures[affiliate];
		if (val > 0) return val;
		return v.minValidatorSignatures[address(0)];
	}

	/// @dev Returns the validatorApprovalTimeout for the affiliate, falling back to address(0) default.
	function _getValidatorApprovalTimeout(ValidatorStorage.Layout storage v, address affiliate) internal view returns (uint256) {
		uint256 val = v.validatorApprovalTimeout[affiliate];
		if (val > 0) return val;
		return v.validatorApprovalTimeout[address(0)];
	}

	/// @dev Returns true if signer is a validator for the affiliate or the default (address(0)).
	function _isValidator(ValidatorStorage.Layout storage v, address affiliate, address signer) internal view returns (bool) {
		return v.validators[affiliate][signer] || v.validators[address(0)][signer];
	}

	// ═══════════════════════════════════════════════════════════════════
	//                  INTERNAL: COLLECT, TRANSFER, RELEASE
	// ═══════════════════════════════════════════════════════════════════

	function _collectAndTransfer(address user, uint256 requestId, WithdrawReceiverPart[] memory parts, WithdrawInfo storage info) internal {
		FeeStorage.Layout storage f = FeeStorage.layout();

		uint256 operatorFee = f.operatorFees[user][requestId];
		uint256 affiliateFee = info.fee + info.accelerationFee;
		uint256 userFee = affiliateFee + operatorFee;

		// STANDARD's onWithdrawComplete fires before processing, so fees go straight to
		// claimable. Non-STANDARD sits in PROCESSED until finalize and is post-payout rollback
		// eligible, so fees stay in per-request escrow.
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

	function _releaseWithdraw(address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.optionType == OptionType.WINDOWED || info.optionType == OptionType.SAME_TX) {
			PoolStorage.Layout storage p = PoolStorage.layout();
			p.lockedGeneralBalance -= info.generalAmount;
			if (info.affiliateAmount > 0) {
				p.lockedAffiliateBalances[info.affiliate] -= info.affiliateAmount;
			}
		}

		LibCreditLine.releaseReservation(user, requestId, info);
	}

	function _handleProcessedRollback(address user, uint256 requestId, WithdrawInfo storage info) internal {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		if (info.optionType == OptionType.STANDARD) revert LibErrors.InvalidPostPayoutRollback();

		_promotePendingFees(user, requestId, info.affiliate);
		_recordGeneralLoss(user, requestId, info);
		LibCreditLine.coverLoss(g.collateral, g.symmio, user, requestId, info);
	}

	/// @dev Promotes escrowed fees to the affiliate's claimable buckets after a post-payout suspension.
	function _promotePendingFees(address user, uint256 requestId, address affiliate) internal {
		FeeStorage.Layout storage f = FeeStorage.layout();
		uint256 pf = f.pendingFees[user][requestId];
		uint256 pof = f.pendingOperatorFees[user][requestId];
		if (pf > 0) f.collectedFees[affiliate] += pf;
		if (pof > 0) f.collectedOperatorFees[affiliate] += pof;
		delete f.pendingFees[user][requestId];
		delete f.pendingOperatorFees[user][requestId];
	}

	function _recordGeneralLoss(address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.generalAmount == 0) return;
		PoolStorage.layout().generalBadDebt += info.generalAmount;
		emit GeneralBadDebtAccrued(user, requestId, info.generalAmount);
	}
}
