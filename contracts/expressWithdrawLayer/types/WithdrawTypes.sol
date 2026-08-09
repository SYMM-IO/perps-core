// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Lifecycle status of a withdrawal within the ExpressProvider system.
///
///  NONE ──[onWithdrawRequest]──► ACCEPTED ──[processWithdraw]──────► PROCESSED ──[onWithdrawComplete]──► FINALIZED
///                                   │  │                               │
///                                   │  ├──[lockWithdraw]──► LOCKED ────┤
///                                   │  │                      │        │
///                                   │  │                      ├────────┤
///                                   │  ├──[onWithdrawComplete (STANDARD)]──► FINALIZED ──[processWithdraw]──► PROCESSED
///                                   │  │
///                                   │  └──[onWithdrawCancelRequest]──► CANCELLED
///                                   │
///                                   └──[onWithdrawSuspend]──► SUSPENDED ◄── (also from LOCKED, PROCESSED)
///
///  SAME_TX bypasses ACCEPTED: onWithdrawRequest sets PROCESSED directly.
enum Status {
	NONE, // Default value; no withdrawal exists for this (user, requestId) pair.
	ACCEPTED, // ExpressProvider accepted the request; funds are reserved but not yet transferred to the user.
	LOCKED, // A LOCKER_ROLE account placed a temporary hold; STANDARD can be unlocked and processed after SYMMIO finalization.
	PROCESSED, // Funds were transferred to the user. For STANDARD this is the post-FINALIZED user payout state.
	FINALIZED, // WINDOWED/SAME_TX terminal success; for STANDARD, tokens arrived and are awaiting processWithdraw.
	CANCELLED, // Terminal — the request was cancelled (only possible from ACCEPTED before processing).
	SUSPENDED // Terminal hold — the request was suspended (possible from ACCEPTED, LOCKED, or PROCESSED; PROCESSED triggers a rollback).
}

/// @notice Withdrawal option tier -- determines when payout is processed.
enum OptionType {
	SAME_TX,
	WINDOWED,
	STANDARD
}

/// @notice Persistent record of an accepted withdrawal, stored per (user, requestId).
struct WithdrawInfo {
	Status status;
	OptionType optionType;
	uint256 availableAt;
	uint256 expressAmount;
	uint256 generalAmount;
	uint256 affiliateAmount;
	uint256 creditAmount;
	address affiliate;
	uint256 acceptedAt;
	uint256 finalizedAt;
	uint256 cooldownEndTime;
	bytes32 partsHash;
	uint256 fee;
	uint256 maxAccelerationFee;
	uint256 accelerationFee;
}
