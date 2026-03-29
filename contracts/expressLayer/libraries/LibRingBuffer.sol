// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Bucket, RingBuffer } from "../types/ConfigTypes.sol";

import { LibErrors } from "./LibErrors.sol";

/// @title LibRingBuffer
/// @notice Generic, storage-parameterized ring buffer for liquidity scheduling.
library LibRingBuffer {
	function numBuckets(uint256 schedulingWindow, uint256 bucketDuration) internal pure returns (uint256) {
		return schedulingWindow / bucketDuration + 1;
	}

	function sync(RingBuffer storage ring, uint256 bucketDuration, uint256 schedulingWindow, uint256 globalConfigNonce) internal {
		if (ring.configNonce != globalConfigNonce) {
			clear(ring, bucketDuration, schedulingWindow);
			ring.configNonce = globalConfigNonce;
			ring.anchorTimestamp = block.timestamp;
			return;
		}

		if (ring.anchorTimestamp == 0) {
			ring.anchorTimestamp = block.timestamp;
			return;
		}

		uint256 elapsed = block.timestamp - ring.anchorTimestamp;
		uint256 bucketsToAdvance = elapsed / bucketDuration;
		if (bucketsToAdvance == 0) return;

		uint256 nb = numBuckets(schedulingWindow, bucketDuration);
		if (bucketsToAdvance > nb) bucketsToAdvance = nb;

		for (uint256 i = 0; i < bucketsToAdvance; i++) {
			delete ring.buckets[(ring.startIndex + i) % nb];
		}

		ring.startIndex = (ring.startIndex + bucketsToAdvance) % nb;
		ring.anchorTimestamp += bucketsToAdvance * bucketDuration;
	}

	function clear(RingBuffer storage ring, uint256 bucketDuration, uint256 schedulingWindow) internal {
		uint256 nb = numBuckets(schedulingWindow, bucketDuration);
		for (uint256 i = 0; i < nb; i++) {
			delete ring.buckets[(ring.startIndex + i) % nb];
		}
		ring.anchorTimestamp = 0;
		ring.startIndex = 0;
	}

	function getBucketOffset(RingBuffer storage ring, uint256 timestamp, uint256 bucketDuration, uint256 nb) internal view returns (uint256 offset) {
		if (timestamp < ring.anchorTimestamp) revert LibErrors.TimestampInThePast();
		if (timestamp == ring.anchorTimestamp) return 0;
		offset = (timestamp - ring.anchorTimestamp - 1) / bucketDuration;
		if (offset >= nb) revert LibErrors.TimestampTooFarInFuture();
	}

	function tryGetBucketOffset(
		RingBuffer storage ring,
		uint256 timestamp,
		uint256 bucketDuration,
		uint256 nb
	) internal view returns (bool tracked, uint256 offset) {
		if (ring.anchorTimestamp == 0 || timestamp < ring.anchorTimestamp) return (false, 0);
		if (timestamp == ring.anchorTimestamp) return (true, 0);
		offset = (timestamp - ring.anchorTimestamp - 1) / bucketDuration;
		if (offset >= nb) return (false, 0);
		return (true, offset);
	}

	function getBucketIndex(RingBuffer storage ring, uint256 timestamp, uint256 bucketDuration, uint256 nb) internal view returns (uint256) {
		return (ring.startIndex + getBucketOffset(ring, timestamp, bucketDuration, nb)) % nb;
	}

	function isLiquidityAvailableBy(
		RingBuffer storage ring,
		uint256 startingAvailable,
		uint256 amount,
		uint256 targetOffset,
		uint256 nb
	) internal view returns (bool) {
		if (amount == 0) return true;

		uint256 totalInflow = 0;
		uint256 totalOutflow = 0;
		for (uint256 i = 0; i <= targetOffset; i++) {
			uint256 idx = (ring.startIndex + i) % nb;
			totalInflow += ring.buckets[idx].expectedInflow;
			totalOutflow += ring.buckets[idx].reservedOutflow;
		}

		return startingAvailable + totalInflow >= totalOutflow + amount;
	}

	function addExpectedInflow(RingBuffer storage ring, uint256 timestamp, uint256 amount, uint256 bucketDuration, uint256 nb) internal {
		if (amount == 0) return;
		uint256 idx = getBucketIndex(ring, timestamp, bucketDuration, nb);
		ring.buckets[idx].expectedInflow += amount;
	}

	function addReservedOutflow(RingBuffer storage ring, uint256 timestamp, uint256 amount, uint256 bucketDuration, uint256 nb) internal {
		if (amount == 0) return;
		uint256 idx = getBucketIndex(ring, timestamp, bucketDuration, nb);
		ring.buckets[idx].reservedOutflow += amount;
	}

	function removeExpectedInflow(RingBuffer storage ring, uint256 timestamp, uint256 amount, uint256 bucketDuration, uint256 nb) internal {
		if (amount == 0) return;
		(bool tracked, uint256 offset) = tryGetBucketOffset(ring, timestamp, bucketDuration, nb);
		if (!tracked) return;
		uint256 idx = (ring.startIndex + offset) % nb;
		if (ring.buckets[idx].expectedInflow >= amount) {
			ring.buckets[idx].expectedInflow -= amount;
		}
	}

	function removeReservedOutflow(RingBuffer storage ring, uint256 timestamp, uint256 amount, uint256 bucketDuration, uint256 nb) internal {
		if (amount == 0) return;
		(bool tracked, uint256 offset) = tryGetBucketOffset(ring, timestamp, bucketDuration, nb);
		if (!tracked) return;
		uint256 idx = (ring.startIndex + offset) % nb;
		if (ring.buckets[idx].reservedOutflow >= amount) {
			ring.buckets[idx].reservedOutflow -= amount;
		}
	}
}
