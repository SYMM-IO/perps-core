// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { IWithdrawFacet } from "./IWithdrawFacet.sol";
import { WithdrawFacetImpl } from "./WithdrawFacetImpl.sol";
import { WithdrawReceiverPart } from "../../storages/WithdrawStorage.sol";

/// @title WithdrawFacet
/// @notice Handles user-initiated withdrawals across classic, virtual-provider, and express-provider paths.
/// @dev This is the external-facing facet for all withdrawal operations.
///      Core logic is implemented in `WithdrawFacetImpl`.
///      Each withdrawal request can contain up to 50 parts, with optional provider involvement.
contract WithdrawFacet is Accessibility, Pausable, IWithdrawFacet, ReentrancyGuard {
	/**
	 * @notice Initiates a new withdrawal request.
	 * @dev
	 * - Users may include multiple withdrawal parts (receivers, amounts, provider flags).
	 * - Provider rules:
	 *      1. Only **one express provider** may appear in the request.
	 *      2. Only **one virtual provider** may appear among virtual-only parts.
	 *      3. Express+virtual parts may contain multiple virtual providers (express is master).
	 * - This function debits the user’s internal balance immediately.
	 * - Providers (if referenced) receive on-chain callbacks through their contracts.
	 *
	 * Emits:
	 * - `WithdrawInitiated`
	 *
	 * @param parts Array of withdrawal instructions. Each part may target a different chain/provider.
	 * @param speedUp Whether to request a speed-up for this withdrawal.
	 * @param data Additional provider-specific metadata.
	 */
	function initiateWithdraw(WithdrawReceiverPart[] memory parts,bool speedUp, bytes memory data) external notSuspended(LibSigner.getSigner()) nonReentrant returns (uint256 requestId, uint256 cooldownEndTime) {
		(requestId, cooldownEndTime) = WithdrawFacetImpl.initiateWithdraw(parts,speedUp, data);
		emit WithdrawInitiated(requestId, LibSigner.getSigner(), parts, speedUp, data, cooldownEndTime);
	}

	/**
	 * @notice Provider accepts a withdrawal request.
	 * @dev
	 * - Must be called **only by the provider contract** (NOT the operator).
	 * - If any express-provider part exists → express provider must accept.
	 * - Otherwise, the single virtual-only provider must accept.
	 * - Marks the request as `PROVIDER_ACCEPTED`.
	 *
	 * Emits:
	 * - `WithdrawAccepted`
	 *
	 * @param user The owner of the withdrawal request.
	 * @param requestId ID of the withdrawal request.
	 */
	function acceptWithdrawRequest(address user, uint256 requestId) external notSuspended(user) nonReentrant {
		WithdrawFacetImpl.acceptWithdrawRequest(user, requestId);
		emit WithdrawAccepted(requestId, user);
	}

	/**
	 * @notice Operator rejects a withdrawal request.
	 * @dev
	 * - Can only be called by an operator.
	 * - Refunds the user’s internal balance immediately.
	 *
	 * Emits:
	 * - `WithdrawRejected`
	 *
	 * @param user The owner of the withdrawal request.
	 * @param requestId ID of the withdrawal request.
	 */
	function rejectWithdrawRequest(address user, uint256 requestId) external notSuspended(user) nonReentrant {
		WithdrawFacetImpl.rejectWithdrawRequest(user, requestId);
		emit WithdrawRejected(requestId, user);
	}

	/**
	 * @notice Finalizes an existing withdrawal request after cooldown expiry.
	 * @dev
	 * - Can only be called by the request owner.
	 * - Classic withdrawal parts transfer directly to receivers.
	 * - Provider-managed parts:
	 *      - Express provider receives total express amount.
	 *      - Virtual provider executes release logic internally.
	 * - Request must be in:
	 *      - `PENDING` (classic-only) OR
	 *      - `PROVIDER_ACCEPTED` (provider flow)
	 *
	 * Emits:
	 * - `WithdrawFinalized`
	 *
	 * @param requestId ID of the withdrawal request.
	 */
	function finalizeWithdrawRequest(address user, uint256 requestId) external notSuspended(user) nonReentrant {
		WithdrawFacetImpl.finalizeWithdrawRequest(user,requestId);
		emit WithdrawFinalized(requestId, LibSigner.getSigner());
	}

	/**
	 * @notice Requests cancellation of a withdrawal during the cooldown period.
	 * @dev
	 * - Classic parts are refunded immediately.
	 * - Pure virtual provider-managed parts cancel immediately and refund funds.
	 * - Express-managed parts:
	 *      - Request transitions to `CANCEL_REQUESTED`.
	 *      - Provider receives a callback to accept/reject cancellation.
	 *
	 * Emits:
	 * - `WithdrawCancelRequested`
	 *
	 * @param requestId ID of the withdrawal request.
	 */
	function requestCancelWithdraw(uint256 requestId) external notSuspended(LibSigner.getSigner()) nonReentrant {
		WithdrawFacetImpl.requestCancelWithdraw(requestId);
		emit WithdrawCancelRequested(requestId, LibSigner.getSigner());
	}

	/**
	 * @notice Force-cancels a withdrawal before cooldown expiry.
	 * @dev
	 * - Only callable by an account with the force-cancel role.
	 * - Request must be in `PENDING`, `PROVIDER_ACCEPTED`, or `CANCEL_REQUESTED`.
	 * - Cancels and refunds immediately, with provider callbacks as needed.
	 *
	 * Emits:
	 * - `WithdrawCancelled`
	 *
	 * @param user The owner of the withdrawal request.
	 * @param requestId ID of the withdrawal request.
	 */
	function forceCancelWithdraw(address user, uint256 requestId) external onlyRole(LibAccessibility.WITHDRAW_FORCE_CANCEL_ROLE) notSuspended(user) nonReentrant {
		WithdrawFacetImpl.forceCancelWithdraw(user, requestId);
		emit WithdrawCancelled(requestId, user);
	}

	/**
	 * @notice Provider accepts a cancellation request.
	 * @dev
	 * - Must be called only by the provider contract (express or virtual).
	 * - Express provider dominates when present; otherwise virtual-only provider is responsible.
	 * - This refunds the remaining provider-held parts and marks the request `CANCELLED`.
	 *
	 * Emits:
	 * - `WithdrawCancelled`
	 *
	 * @param user The user who initiated the withdrawal.
	 * @param requestId ID of the withdrawal request.
	 */
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external notSuspended(user) nonReentrant {
		WithdrawFacetImpl.acceptWithdrawCancelRequest(user, requestId);
		emit WithdrawCancelled(requestId, user);
	}

	/**
	 * @notice Operator suspends a problematic withdrawal request.
	 * @dev
	 * - Can only be called by an operator.
	 * - Suspended requests cannot progress until manually resolved.
	 *
	 * Emits:
	 * - `WithdrawSuspended`
	 *
	 * @param user The user who initiated the withdrawal.
	 * @param requestId ID of the withdrawal request.
	 */
	function suspendWithdrawRequest(address user, uint256 requestId) external nonReentrant {
		WithdrawFacetImpl.suspendWithdrawRequest(user, requestId);
		emit WithdrawSuspended(requestId, user);
	}

	/**
	 * @notice Operator accepts a speed-up request for a withdrawal.
	 * @dev
	 * - Can only be called by an operator with the appropriate role.
	 * - Reduces the remaining cooldown time for the specified withdrawal request.
	 *
	 * Emits:
	 * - `WithdrawSpeedUpAccepted`
	 *
	 * @param user The user who initiated the withdrawal.
	 * @param requestId ID of the withdrawal request.
	 * @param newCooldown The new cooldown time in seconds.
	 */
	function acceptSpeedUpRequest(address user, uint256 requestId, uint256 newCooldown) external notSuspended(user) onlyRole(LibAccessibility.WITHDRAW_SPEED_UP_ROLE) nonReentrant {
		WithdrawFacetImpl.acceptSpeedUpRequest(user, requestId, newCooldown);
		emit WithdrawSpeedUpAccepted(requestId, user, newCooldown);
	}
}
