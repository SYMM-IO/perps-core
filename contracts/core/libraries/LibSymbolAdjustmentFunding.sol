// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import { FundingStorage, FundingFee } from "../storages/FundingStorage.sol";
import { SymbolAdjustmentStorage, SymbolAdjustment, FundingRateCheckpoint } from "../storages/SymbolAdjustmentStorage.sol";
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
		if (fundingFee.epochDuration == 0 || (fundingFee.currentLongRate == 0 && fundingFee.currentShortRate == 0)) return false;

		// Preserve all funding earned on the old quote basis before opening the zero-rate interval.
		LibFundingRate.updateAccumulatedRatesAt(fundingFee, fundingCutoffTimestamp);
		checkpoint.currentLongRate = fundingFee.currentLongRate;
		checkpoint.currentShortRate = fundingFee.currentShortRate;
		checkpoint.restatementEpoch = restatementEpoch;
		adjustmentLayout.adjustments[symbolId].pendingFundingPartyBCount += 1;

		fundingFee.currentLongRate = 0;
		fundingFee.currentShortRate = 0;
		LibFundingRate.emitAccumulatedFundingStateUpdated(symbolId, partyB, fundingFee);
		return true;
	}

	/// @notice Restores checkpoints only for the PartyBs explicitly supplied by Operations.
	/// @dev Abort does not roll the zero interval, so the original rates apply continuously. Finalization rolls every pair to one shared timestamp.
	function restoreFundingRates(
		uint256 symbolId,
		uint256 restatementEpoch,
		uint256 factor,
		bool settlePausedInterval,
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
			if (settlePausedInterval && fundingFee.epochDuration > 0) {
				// Roll the zero-rate maintenance interval into the cumulative state before resuming accrual.
				LibFundingRate.updateAccumulatedRatesAt(fundingFee, fundingRestorationTimestamp);
			}

			fundingFee.currentLongRate = settlePausedInterval ? _rebaseRate(checkpoint.currentLongRate, factor) : checkpoint.currentLongRate;
			fundingFee.currentShortRate = settlePausedInterval ? _rebaseRate(checkpoint.currentShortRate, factor) : checkpoint.currentShortRate;
			LibFundingRate.emitAccumulatedFundingStateUpdated(symbolId, partyB, fundingFee);
			delete adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
			adjustment.pendingFundingPartyBCount -= 1;
			processedPartyBs += 1;
		}

		remainingPartyBs = adjustment.pendingFundingPartyBCount;
	}

	function pendingFundingPartyBs(uint256 symbolId) internal view returns (uint256) {
		return SymbolAdjustmentStorage.layout().adjustments[symbolId].pendingFundingPartyBCount;
	}

	/// @dev A quote's open amount is multiplied by `factor`, so its price-adjusted per-unit funding rate is divided by the same factor.
	function _rebaseRate(int256 rate, uint256 factor) private pure returns (int256) {
		if (rate == 0) return 0;
		uint256 magnitude = Math.mulDiv(SignedMath.abs(rate), ONE, factor);
		require(magnitude <= uint256(type(int256).max), "LibSymbolAdjustmentFunding: Funding rate overflow");
		return rate < 0 ? -int256(magnitude) : int256(magnitude);
	}
}
