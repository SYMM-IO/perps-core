// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Fee configuration for an affiliate (protocol fee rate + flat operator fee).
struct AffiliateConfig {
	uint256 feeRate;
	uint256 operatorFee;
}

/// @notice Guardrails controlling how much a sponsor subsidizes per withdrawal.
struct SponsorConfig {
	uint256 maxFeePerWithdraw;
	uint256 maxWithdrawAmount;
}

/// @notice A single time-slot in the ring buffer used for liquidity forecasting.
struct Bucket {
	uint256 expectedInflow;
	uint256 reservedOutflow;
}

/// @notice Self-contained ring buffer instance for liquidity scheduling.
/// @dev One instance exists for the general pool, plus one per affiliate.
///      Global config (bucketDuration, schedulingWindow) is shared; only the
///      per-bucket data and sync state are per-ring.
struct RingBuffer {
	mapping(uint256 => Bucket) buckets;
	uint256 anchorTimestamp;
	uint256 startIndex;
	uint256 configNonce;
}
