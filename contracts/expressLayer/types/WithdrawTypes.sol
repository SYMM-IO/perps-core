// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Lifecycle status of a withdrawal within the ExpressProvider system.
enum Status {
	NONE,
	ACCEPTED,
	LOCKED,
	PROCESSED,
	FINALIZED,
	CANCELLED,
	SUSPENDED
}

/// @notice Withdrawal speed tier — determines how and when capital is fronted.
enum OptionType {
	IMMEDIATE,
	INSTANT,
	SCHEDULED,
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
	address creditLineManager;
	uint256 acceptedAt;
	uint256 finalizedAt;
	uint256 cooldownEndTime;
	bytes32 partsHash;
	uint256 fee;
	uint256 sponsorCoverage;
}
