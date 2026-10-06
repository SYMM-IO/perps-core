// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import { FundingStorage, FundingFee } from "../storages/FundingStorage.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment, FundingRateCheckpoint, RestatementPhase } from "../storages/SymbolAdjustmentStorage.sol";
import { LibFundingRate } from "./LibFundingRate.sol";

/// @title LibSymbolAdjustmentFunding
/// @notice Owns the funding-rate basis transition around physical quote restatement.
library LibSymbolAdjustmentFunding {
	uint256 internal constant ONE = 1e18;

	/// @notice Prepares only the PartyBs explicitly supplied by Operations at a shared funding cutoff.
	function prepareFundingRatesForRestatement(
		uint256 symbolId,
		uint256 restatementEpoch,
		uint256 fundingCutoffTimestamp,
		address[] calldata partyBs
	) internal returns (uint256 checkpointedPartyBs) {
		for (uint256 i = 0; i < partyBs.length; i++) {
			if (preparePartyBFundingRatesForRestatement(symbolId, partyBs[i], restatementEpoch, fundingCutoffTimestamp)) {
				checkpointedPartyBs += 1;
			}
		}
	}

	/// @notice Prepares one symbol/PartyB funding pair once. The quote path uses this for legacy deregistered PartyBs.
	function preparePartyBFundingRatesForRestatement(
		uint256 symbolId,
		address partyB,
		uint256 restatementEpoch,
		uint256 fundingCutoffTimestamp
	) internal returns (bool checkpointed) {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		FundingRateCheckpoint storage checkpoint = adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
		if (checkpoint.restatementEpoch == restatementEpoch) return false;

		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0) return false;

		checkpoint.currentLongRate = fundingFee.currentLongRate;
		checkpoint.currentShortRate = fundingFee.currentShortRate;
		checkpoint.restatedLongRate = _rebaseRate(fundingFee.currentLongRate, adjustmentLayout.adjustments[symbolId].restatementFactor);
		checkpoint.restatedShortRate = _rebaseRate(fundingFee.currentShortRate, adjustmentLayout.adjustments[symbolId].restatementFactor);
		checkpoint.restatementEpoch = restatementEpoch;
		adjustmentLayout.adjustments[symbolId].pendingFundingPartyBCount += 1;

		// Convert every completed old-basis epoch into an exact cumulative snapshot, then reset epoch tracking.
		// The zero current rates make the maintenance interval economically inert without averaging it into history.
		LibFundingRate.crystallizeAndPauseAt(fundingFee, fundingCutoffTimestamp);
		LibFundingRate.emitAccumulatedFundingStateUpdated(symbolId, partyB, fundingFee);
		return true;
	}

	/// @notice Restores checkpoints only for the PartyBs explicitly supplied by Operations.
	/// @dev Both exits start a fresh epoch at one shared timestamp. Abort resumes the original rates; finalization resumes their restated-basis values.
	function restoreFundingRates(
		uint256 symbolId,
		uint256 restatementEpoch,
		bool finalizing,
		uint256 fundingRestorationTimestamp,
		address[] calldata partyBs
	) internal returns (uint256 processedPartyBs, uint256 remainingPartyBs) {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[symbolId];

		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];
			FundingRateCheckpoint storage checkpoint = adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
			if (checkpoint.restatementEpoch != restatementEpoch) continue;

			FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
			LibFundingRate.restartAt(
				fundingFee,
				finalizing ? checkpoint.restatedLongRate : checkpoint.currentLongRate,
				finalizing ? checkpoint.restatedShortRate : checkpoint.currentShortRate,
				fundingRestorationTimestamp
			);
			LibFundingRate.emitAccumulatedFundingStateUpdated(symbolId, partyB, fundingFee);
			delete adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
			adjustment.pendingFundingPartyBCount -= 1;
			processedPartyBs += 1;
		}

		remainingPartyBs = adjustment.pendingFundingPartyBCount;
	}

	/// @notice Resolves the economic funding state while a restatement pause or batched restart is in progress.
	/// @dev Before exit begins, timestamps are capped at the shared start cutoff even if a PartyB has not yet been
	///      materialized by an operator batch. During batched exit, an unprocessed checkpoint is projected as though
	///      its fresh epoch had already started, keeping liquidation and aggregate views independent of batch order.
	function effectiveFundingFeeAt(
		uint256 symbolId,
		address partyB,
		uint256 timestamp
	) internal view returns (FundingFee memory fundingFee, uint256 effectiveTimestamp) {
		fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
		effectiveTimestamp = timestamp;
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		SymbolAdjustment storage adjustment = adjustmentLayout.adjustments[symbolId];
		if (!adjustment.restating || fundingFee.epochDuration == 0) return (fundingFee, effectiveTimestamp);

		bool finalizing = adjustment.restatementPhase == RestatementPhase.FINALIZATION_FUNDING_RESTORATION;
		bool aborting = adjustment.restatementPhase == RestatementPhase.ABORT_FUNDING_RESTORATION;
		if (!finalizing && !aborting) {
			if (effectiveTimestamp > adjustment.fundingCutoffTimestamp) effectiveTimestamp = adjustment.fundingCutoffTimestamp;
			return (fundingFee, effectiveTimestamp);
		}

		uint256 restartTimestamp = adjustment.fundingRestorationTimestamp;
		if (effectiveTimestamp < restartTimestamp) {
			return (_pausedFundingFee(fundingFee, adjustment.fundingCutoffTimestamp), adjustment.fundingCutoffTimestamp);
		}

		FundingRateCheckpoint storage checkpoint = adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
		if (checkpoint.restatementEpoch == adjustment.restatementEpoch) {
			fundingFee.currentLongRate = finalizing ? checkpoint.restatedLongRate : checkpoint.currentLongRate;
			fundingFee.currentShortRate = finalizing ? checkpoint.restatedShortRate : checkpoint.currentShortRate;
			fundingFee.accumulatedLongRate = 0;
			fundingFee.accumulatedShortRate = 0;
			fundingFee.lastUpdatedEpoch = LibFundingRate.getEpochOfTimestamp(restartTimestamp, fundingFee.epochDuration);
			fundingFee.startEpoch = fundingFee.lastUpdatedEpoch;
			fundingFee.lastUpdatedTimeStamp = restartTimestamp;
			fundingFee.startEpochTimeStamp = restartTimestamp;
		}
	}

	function pendingFundingPartyBs(uint256 symbolId) internal view returns (uint256) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId].pendingFundingPartyBCount;
	}

	function _pausedFundingFee(FundingFee memory fundingFee, uint256 cutoffTimestamp) private pure returns (FundingFee memory) {
		if (fundingFee.lastUpdatedTimeStamp <= cutoffTimestamp && fundingFee.startEpochTimeStamp <= cutoffTimestamp) {
			(fundingFee.snapshotLongFee, fundingFee.snapshotShortFee) = LibFundingRate.cumulativeRatesAt(fundingFee, cutoffTimestamp);
		}
		uint256 epoch = LibFundingRate.getEpochOfTimestamp(cutoffTimestamp, fundingFee.epochDuration);
		fundingFee.currentLongRate = 0;
		fundingFee.currentShortRate = 0;
		fundingFee.accumulatedLongRate = 0;
		fundingFee.accumulatedShortRate = 0;
		fundingFee.lastUpdatedEpoch = epoch;
		fundingFee.startEpoch = epoch;
		fundingFee.lastUpdatedTimeStamp = cutoffTimestamp;
		fundingFee.startEpochTimeStamp = cutoffTimestamp;
		return fundingFee;
	}

	/// @dev A quote's open amount is multiplied by `factor`, so its price-adjusted per-unit funding rate is divided by the same factor.
	function _rebaseRate(int256 rate, uint256 factor) private pure returns (int256) {
		if (rate == 0) return 0;
		uint256 magnitude = Math.mulDiv(SignedMath.abs(rate), ONE, factor);
		require(magnitude <= uint256(type(int256).max), "LibSymbolAdjustmentFunding: Funding rate overflow");
		return rate < 0 ? -int256(magnitude) : int256(magnitude);
	}
}
