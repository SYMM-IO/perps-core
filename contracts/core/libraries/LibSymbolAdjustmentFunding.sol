// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import { FundingStorage, FundingFee } from "../storages/FundingStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { SymbolAdjustmentStorage, FundingRateCheckpoint } from "../storages/SymbolAdjustmentStorage.sol";
import { LibFundingRate } from "./LibFundingRate.sol";

/// @title LibSymbolAdjustmentFunding
/// @notice Owns the funding-rate basis transition around physical quote restatement.
library LibSymbolAdjustmentFunding {
	uint256 internal constant ONE = 1e18;

	/// @notice Prepares every registered PartyB's funding rates for one shared restatement boundary.
	function prepareFundingRatesForRestatement(uint256 symbolId, uint256 restatementEpoch) internal {
		address[] storage partyBs = MAStorage.layout().partyBList;
		for (uint256 i = 0; i < partyBs.length; i++) {
			preparePartyBFundingRatesForRestatement(symbolId, partyBs[i], restatementEpoch);
		}
	}

	/// @notice Prepares one symbol/PartyB funding pair once. The quote path uses this for legacy deregistered PartyBs.
	function preparePartyBFundingRatesForRestatement(uint256 symbolId, address partyB, uint256 restatementEpoch) internal {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		FundingRateCheckpoint storage checkpoint = adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
		if (checkpoint.restatementEpoch == restatementEpoch) return;

		FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
		if (fundingFee.epochDuration == 0 || (fundingFee.currentLongRate == 0 && fundingFee.currentShortRate == 0)) return;

		// Preserve all funding earned on the old quote basis before opening the zero-rate interval.
		LibFundingRate.updateAccumulatedRates(fundingFee);
		checkpoint.currentLongRate = fundingFee.currentLongRate;
		checkpoint.currentShortRate = fundingFee.currentShortRate;
		checkpoint.restatementEpoch = restatementEpoch;
		adjustmentLayout.restatementFundingPartyBs[symbolId].push(partyB);

		fundingFee.currentLongRate = 0;
		fundingFee.currentShortRate = 0;
		LibFundingRate.emitAccumulatedFundingStateUpdated(symbolId, partyB, fundingFee);
	}

	/// @notice Restores the old rates after a mutation-free abort.
	/// @dev Not rolling the zero interval makes the original rates apply continuously, as if the aborted window had never paused them.
	function restoreAfterAbort(uint256 symbolId, uint256 restatementEpoch) internal {
		_restore(symbolId, restatementEpoch, ONE, false);
	}

	/// @notice Ends the zero-rate interval and restores rates on the new quote basis.
	function restoreAfterFinalization(uint256 symbolId, uint256 restatementEpoch, uint256 factor) internal {
		_restore(symbolId, restatementEpoch, factor, true);
	}

	function _restore(uint256 symbolId, uint256 restatementEpoch, uint256 factor, bool settlePausedInterval) private {
		SymbolAdjustmentStorage.Layout storage adjustmentLayout = SymbolAdjustmentStorage.layout();
		address[] storage partyBs = adjustmentLayout.restatementFundingPartyBs[symbolId];

		for (uint256 i = 0; i < partyBs.length; i++) {
			address partyB = partyBs[i];
			FundingRateCheckpoint storage checkpoint = adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
			require(checkpoint.restatementEpoch == restatementEpoch, "LibSymbolAdjustmentFunding: Invalid checkpoint");

			FundingFee storage fundingFee = FundingStorage.layout().fundingFees[symbolId][partyB];
			if (settlePausedInterval && fundingFee.epochDuration > 0) {
				// Roll the zero-rate maintenance interval into the cumulative state before resuming accrual.
				LibFundingRate.updateAccumulatedRates(fundingFee);
			}

			fundingFee.currentLongRate = settlePausedInterval ? _rebaseRate(checkpoint.currentLongRate, factor) : checkpoint.currentLongRate;
			fundingFee.currentShortRate = settlePausedInterval ? _rebaseRate(checkpoint.currentShortRate, factor) : checkpoint.currentShortRate;
			LibFundingRate.emitAccumulatedFundingStateUpdated(symbolId, partyB, fundingFee);
			delete adjustmentLayout.fundingRateCheckpoints[symbolId][partyB];
		}

		delete adjustmentLayout.restatementFundingPartyBs[symbolId];
	}

	/// @dev A quote's open amount is multiplied by `factor`, so its price-adjusted per-unit funding rate is divided by the same factor.
	function _rebaseRate(int256 rate, uint256 factor) private pure returns (int256) {
		if (rate == 0) return 0;
		uint256 magnitude = Math.mulDiv(SignedMath.abs(rate), ONE, factor);
		require(magnitude <= uint256(type(int256).max), "LibSymbolAdjustmentFunding: Funding rate overflow");
		return rate < 0 ? -int256(magnitude) : int256(magnitude);
	}
}
