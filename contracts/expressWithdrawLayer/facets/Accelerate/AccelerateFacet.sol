// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { AccelerateOffer } from "../../types/AccelerateTypes.sol";
import { CreditData } from "../../types/CreditTypes.sol";
import { WithdrawInfo, Status, OptionType } from "../../types/WithdrawTypes.sol";
import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";

import { IAccelerateFacet } from "./IAccelerateFacet.sol";
import { IOperatorEvents } from "../Operator/IOperatorFacet.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";
import { LibParts } from "../../libraries/LibParts.sol";
import { LibValidators } from "../../libraries/LibValidators.sol";

import { GlobalStorage } from "../../storages/GlobalStorage.sol";
import { PoolStorage } from "../../storages/PoolStorage.sol";
import { FeeStorage } from "../../storages/FeeStorage.sol";

import { Pausable } from "../../utils/Pausable.sol";
import { ReentrancyGuard } from "../../utils/ReentrancyGuard.sol";

/// @title AccelerateFacet
/// @notice Permissionless entrypoint that promotes an ACCEPTED STANDARD withdrawal to
///         WINDOWED-style processing once the affiliate credit cap has capacity. The bot
///         signs a fresh `AccelerateOffer` off-chain; any caller (bot, frontend, user)
///         can submit it here. On success: credit is reserved and activated (advancing
///         collateral from core), pool funds are locked and deducted, and the user is
///         paid without waiting for cooldown. On cap breach: the whole tx reverts atomically, preserving
///         the STANDARD request so the same signature can be retried later.
contract AccelerateFacet is IAccelerateFacet, IOperatorEvents, Pausable, ReentrancyGuard {
	function accelerateWithdraw(
		address user,
		uint256 requestId,
		WithdrawReceiverPart[] calldata parts,
		bytes calldata accelerateOfferData,
		bytes calldata validatorData,
		bytes calldata creditDataRaw
	) external nonReentrant whenNotPaused {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		WithdrawInfo storage info = g.withdrawInfos[user][requestId];

		// ── Preconditions ──
		if (info.status != Status.ACCEPTED) revert LibErrors.AccelerateOnlyFromStandardAccepted();
		if (info.optionType != OptionType.STANDARD) revert LibErrors.AccelerateOnlyFromStandardAccepted();
		if (info.finalizedAt != 0) revert LibErrors.StandardAlreadyFinalized();
		if (block.timestamp >= info.cooldownEndTime) revert LibErrors.AccelerateCooldownElapsed();

		AccelerateOffer memory offer = abi.decode(accelerateOfferData, (AccelerateOffer));

		if (block.timestamp > offer.deadline) revert LibErrors.AccelerateOfferExpired();
		if (g.accelerateNonces[user][requestId] != offer.nonce) revert LibErrors.InvalidAccelerateNonce();
		if (keccak256(abi.encode(parts)) != info.partsHash) revert LibErrors.PartsMismatch();

		_verifyOfferSignature(user, requestId, offer, info.partsHash);

		// Affiliates with a validator quorum policy also enforce it on acceleration. The STANDARD
		// accept path skips validators, so this is the first and only vetting this withdrawal gets,
		// and it guards the advance itself. Same last-balance-credit freshness rule as the accept path.
		address affiliate = info.affiliate;
		if (LibValidators.getMinValidatorSignatures(affiliate) > 0) {
			LibValidators.validateAccelerateApprovals(affiliate, user, requestId, info.partsHash, validatorData);
		}

		// ── Recompute funding split over the preserved expressAmount ──
		if (offer.affiliateAmount + offer.creditAmount > info.expressAmount) {
			revert LibErrors.FundingSplitExceedsExpress();
		}
		uint256 newGeneralAmount = info.expressAmount - offer.affiliateAmount - offer.creditAmount;
		if (offer.accelerationFee > info.maxAccelerationFee) revert LibErrors.AccelerationFeeExceedsMaximum();

		uint256 operatorFee = FeeStorage.layout().operatorFees[user][requestId];
		uint256 totalFee = info.fee + operatorFee + offer.accelerationFee;
		if (totalFee > info.expressAmount) revert LibErrors.FeesExceedExpressAmount();

		// ── Effects ──
		g.accelerateNonces[user][requestId]++;

		// Reserve credit as an atomic retry gate. If the affiliate cap is still full, this
		// reverts the entire tx (including the nonce bump), leaving STANDARD intact.
		if (offer.creditAmount > 0) {
			LibCreditLine.reserveDebt(affiliate, user, requestId, offer.creditAmount, abi.decode(creditDataRaw, (CreditData)));
		}

		// Lock new pool allocations against current balances.
		_lockPools(affiliate, newGeneralAmount, offer.affiliateAmount);

		// Update info with the new funding split; `expressAmount`, `cooldownEndTime`,
		// `acceptedAt`, and `partsHash` are intentionally preserved.
		info.optionType = OptionType.WINDOWED;
		info.generalAmount = newGeneralAmount;
		info.affiliateAmount = offer.affiliateAmount;
		info.creditAmount = offer.creditAmount;
		info.accelerationFee = offer.accelerationFee;

		_unlockAndDeductPools(info);
		info.status = Status.PROCESSED;

		// ── Interactions ──
		LibCreditLine.activate(g.symmio, user, requestId, info);
		_collectAndTransfer(user, requestId, parts, info);

		emit WithdrawAccelerated(user, requestId, affiliate, offer.affiliateAmount, offer.creditAmount, newGeneralAmount);
		emit WithdrawProcessed(user, requestId);
	}

	// ═══════════════════════════════════════════════════════════════════
	//                            INTERNAL
	// ═══════════════════════════════════════════════════════════════════

	function _verifyOfferSignature(address user, uint256 requestId, AccelerateOffer memory offer, bytes32 partsHash) internal view {
		bytes32 structHash = keccak256(
			abi.encode(
				LibAccessControl.ACCELERATE_OFFER_TYPEHASH,
				user,
				requestId,
				offer.nonce,
				offer.affiliateAmount,
				offer.creditAmount,
				offer.accelerationFee,
				partsHash,
				offer.deadline
			)
		);
		address signer = ECDSA.recover(LibAccessControl.hashTypedDataV4(structHash), offer.signature);
		if (!LibAccessControl.hasRole(LibAccessControl.SIGNER_ROLE, signer)) revert LibErrors.InvalidAccelerateSigner();
	}

	function _lockPools(address affiliate, uint256 generalAmount, uint256 affiliateAmount) internal {
		PoolStorage.Layout storage p = PoolStorage.layout();

		if (generalAmount > 0 && p.generalBalance - p.lockedGeneralBalance < generalAmount) {
			revert LibErrors.InsufficientGeneralBalance();
		}
		if (affiliateAmount > 0 && p.affiliateBalances[affiliate] - p.lockedAffiliateBalances[affiliate] < affiliateAmount) {
			revert LibErrors.InsufficientAffiliateBalance();
		}

		p.lockedGeneralBalance += generalAmount;
		if (affiliateAmount > 0) {
			p.lockedAffiliateBalances[affiliate] += affiliateAmount;
		}
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
