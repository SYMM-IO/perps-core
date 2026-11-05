// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { FundingFee } from "../storages/FundingStorage.sol";

library LibFundingRate {
	event AccumulatedFundingStateUpdated(
		uint256 indexed symbolId,
		address indexed partyB,
		int256 currentLongRate,
		int256 currentShortRate,
		int256 accumulatedLongRate,
		int256 accumulatedShortRate,
		uint256 lastUpdatedEpoch,
		uint256 lastUpdatedTimeStamp,
		uint256 startEpochTimeStamp,
		uint256 startEpoch,
		uint256 epochDuration,
		int256 snapshotLongFee,
		int256 snapshotShortFee
	);

	/// @notice Returns the epoch number for a given timestamp and epoch duration.
	function getEpochOfTimestamp(uint256 timestamp, uint256 epochDuration) internal pure returns (uint256) {
		require(epochDuration > 0, "FundingRateFacet: Zero epoch duration");
		return timestamp / epochDuration;
	}

	/// @notice Returns the number of epochs elapsed since the last funding rate update.
	function getEpochsSinceLastUpdate(FundingFee memory fundingFee) internal view returns (uint256) {
		return getEpochsSinceLastUpdateAt(fundingFee, block.timestamp);
	}

	/// @notice Returns the number of epochs elapsed since the last funding rate update at a specific timestamp.
	function getEpochsSinceLastUpdateAt(FundingFee memory fundingFee, uint256 timestamp) internal pure returns (uint256) {
		uint256 currentEpoch = getEpochOfTimestamp(timestamp, fundingFee.epochDuration);
		require(currentEpoch >= fundingFee.lastUpdatedEpoch, "FundingRateFacet: Timestamp before last update");
		return currentEpoch - fundingFee.lastUpdatedEpoch;
	}

	/// @notice Returns the number of epochs elapsed since the funding fee start epoch.
	function getEpochsSinceStart(FundingFee memory fundingFee) internal view returns (uint256) {
		return getEpochsSinceStartAt(fundingFee, block.timestamp);
	}

	/// @notice Returns the number of epochs elapsed since the funding fee start epoch at a specific timestamp.
	function getEpochsSinceStartAt(FundingFee memory fundingFee, uint256 timestamp) internal pure returns (uint256) {
		uint256 currentEpoch = getEpochOfTimestamp(timestamp, fundingFee.epochDuration);
		require(currentEpoch >= fundingFee.startEpoch, "FundingRateFacet: Timestamp before funding start");
		return currentEpoch - fundingFee.startEpoch;
	}

	/// @notice Returns the number of epochs elapsed since the given timestamp.
	function getEpochsSince(FundingFee memory fundingFee, uint256 timestamp) internal view returns (uint256) {
		return getEpochsSinceAt(fundingFee, timestamp, block.timestamp);
	}

	/// @notice Returns the number of epochs elapsed between two timestamps.
	function getEpochsSinceAt(FundingFee memory fundingFee, uint256 fromTimestamp, uint256 toTimestamp) internal pure returns (uint256) {
		uint256 currentEpoch = getEpochOfTimestamp(toTimestamp, fundingFee.epochDuration);
		uint256 lastUpdatedEpoch = getEpochOfTimestamp(fromTimestamp, fundingFee.epochDuration);
		require(currentEpoch >= lastUpdatedEpoch, "FundingRateFacet: Timestamp before funding timestamp");
		return currentEpoch - lastUpdatedEpoch;
	}

	/// @notice Returns the exact cumulative per-unit funding represented by a funding record at a timestamp.
	/// @dev This deliberately returns the weighted sum rather than dividing it back into an average, so callers can
	///      crystallize history without introducing another rounding step.
	function cumulativeRatesAt(FundingFee memory fundingFee, uint256 timestamp) internal pure returns (int256 longFee, int256 shortFee) {
		uint256 epochsSinceLastUpdate = getEpochsSinceLastUpdateAt(fundingFee, timestamp);
		uint256 epochsBeforeLastUpdate = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch;
		longFee =
			fundingFee.snapshotLongFee +
			(fundingFee.accumulatedLongRate * int256(epochsBeforeLastUpdate)) +
			(fundingFee.currentLongRate * int256(epochsSinceLastUpdate));
		shortFee =
			fundingFee.snapshotShortFee +
			(fundingFee.accumulatedShortRate * int256(epochsBeforeLastUpdate)) +
			(fundingFee.currentShortRate * int256(epochsSinceLastUpdate));
	}

	/// @notice Crystallizes all completed funding at a cutoff and starts a zero-rate paused epoch there.
	function crystallizeAndPauseAt(FundingFee storage fundingFee, uint256 timestamp) internal {
		(fundingFee.snapshotLongFee, fundingFee.snapshotShortFee) = cumulativeRatesAt(fundingFee, timestamp);
		restartAt(fundingFee, 0, 0, timestamp);
	}

	/// @notice Starts a fresh funding epoch without changing the already-crystallized cumulative snapshots.
	function restartAt(FundingFee storage fundingFee, int256 longRate, int256 shortRate, uint256 timestamp) internal {
		uint256 epoch = getEpochOfTimestamp(timestamp, fundingFee.epochDuration);
		fundingFee.currentLongRate = longRate;
		fundingFee.currentShortRate = shortRate;
		fundingFee.accumulatedLongRate = 0;
		fundingFee.accumulatedShortRate = 0;
		fundingFee.lastUpdatedEpoch = epoch;
		fundingFee.lastUpdatedTimeStamp = timestamp;
		fundingFee.startEpochTimeStamp = timestamp;
		fundingFee.startEpoch = epoch;
	}

	/// @notice Updates the weighted average accumulated funding rates based on elapsed epochs.
	function updateAccumulatedRates(
		FundingFee storage fundingFee
	) internal returns (int256 accumulatedLongRate, int256 accumulatedShortRate, bool stateUpdated) {
		return updateAccumulatedRatesAt(fundingFee, block.timestamp);
	}

	/// @notice Updates accumulated funding rates at a fixed timestamp shared by a batched operation.
	function updateAccumulatedRatesAt(
		FundingFee storage fundingFee,
		uint256 timestamp
	) internal returns (int256 accumulatedLongRate, int256 accumulatedShortRate, bool stateUpdated) {
		uint256 newEpochs = getEpochsSinceLastUpdateAt(fundingFee, timestamp);
		uint256 previousEpochs = fundingFee.lastUpdatedEpoch - fundingFee.startEpoch;

		if (previousEpochs == 0 && newEpochs == 0) {
			accumulatedLongRate = int256(fundingFee.accumulatedLongRate);
			accumulatedShortRate = int256(fundingFee.accumulatedShortRate);
			return (accumulatedLongRate, accumulatedShortRate, false);
		}

		uint256 totalEpochs = previousEpochs + newEpochs;

		fundingFee.accumulatedLongRate =
			(fundingFee.accumulatedLongRate * int256(previousEpochs) + fundingFee.currentLongRate * int256(newEpochs)) / int256(totalEpochs);

		fundingFee.accumulatedShortRate =
			(fundingFee.accumulatedShortRate * int256(previousEpochs) + fundingFee.currentShortRate * int256(newEpochs)) / int256(totalEpochs);

		fundingFee.lastUpdatedEpoch = getEpochOfTimestamp(timestamp, fundingFee.epochDuration);
		fundingFee.lastUpdatedTimeStamp = timestamp;

		return (fundingFee.accumulatedLongRate, fundingFee.accumulatedShortRate, true);
	}

	/// @notice Emits the full symbol/PartyB accumulated funding state after callers finish mutating it.
	function emitAccumulatedFundingStateUpdated(uint256 symbolId, address partyB, FundingFee storage fundingFee) internal {
		emit AccumulatedFundingStateUpdated(
			symbolId,
			partyB,
			fundingFee.currentLongRate,
			fundingFee.currentShortRate,
			fundingFee.accumulatedLongRate,
			fundingFee.accumulatedShortRate,
			fundingFee.lastUpdatedEpoch,
			fundingFee.lastUpdatedTimeStamp,
			fundingFee.startEpochTimeStamp,
			fundingFee.startEpoch,
			fundingFee.epochDuration,
			fundingFee.snapshotLongFee,
			fundingFee.snapshotShortFee
		);
	}
}
