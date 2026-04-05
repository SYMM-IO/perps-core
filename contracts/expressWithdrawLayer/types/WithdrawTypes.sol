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
///                                   │  ├──[onWithdrawComplete (STANDARD)]──► FINALIZED
///                                   │  │
///                                   │  └──[onWithdrawCancelRequest]──► CANCELLED
///                                   │
///                                   └──[onWithdrawSuspend]──► SUSPENDED ◄── (also from LOCKED, PROCESSED)
///
///  IMMEDIATE bypasses ACCEPTED: onWithdrawRequest sets PROCESSED directly.
enum Status {
	NONE, // Default value; no withdrawal exists for this (user, requestId) pair.
	ACCEPTED, // ExpressProvider accepted the request; funds are reserved but not yet transferred to the user.
	LOCKED, // A LOCKER_ROLE account placed a temporary hold; transitions to PROCESSED after the cooldown period via unlockAndProcess.
	PROCESSED, // Funds have been collected from pools / credit and transferred to the user; awaiting SYMMIO cooldown reimbursement.
	FINALIZED, // Terminal success — SYMMIO reimbursed the provider and pools / credit debt are settled.
	CANCELLED, // Terminal — the request was cancelled (only possible from ACCEPTED before processing).
	SUSPENDED // Terminal hold — the request was suspended (possible from ACCEPTED, LOCKED, or PROCESSED; PROCESSED triggers a rollback).
}

/// @notice Withdrawal speed tier — determines how and when capital is fronted.
enum OptionType {
	IMMEDIATE,
	INSTANT,
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
	uint256 sponsorCoverage;
}
