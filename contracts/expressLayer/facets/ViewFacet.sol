// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AffiliateConfig, SponsorConfig, RingBuffer } from "../types/ConfigTypes.sol";
import { WithdrawInfo } from "../types/WithdrawTypes.sol";

import { LibAccessControl } from "../libraries/LibAccessControl.sol";
import { LibRingBuffer } from "../libraries/LibRingBuffer.sol";

import { ExpressProviderStorage } from "../storages/ExpressProviderStorage.sol";

/// @title ViewFacet
/// @notice Read-only facet exposing all state getters for the ExpressProvider diamond.
contract ViewFacet {
	// ── Core addresses ──

	function symmio() external view returns (address) {
		return ExpressProviderStorage.layout().symmio;
	}

	function collateral() external view returns (address) {
		return address(ExpressProviderStorage.layout().collateral);
	}

	// ── Pool balances ──

	function generalBalance() external view returns (uint256) {
		return ExpressProviderStorage.layout().generalBalance;
	}

	function lockedGeneralBalance() external view returns (uint256) {
		return ExpressProviderStorage.layout().lockedGeneralBalance;
	}

	function affiliateBalances(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().affiliateBalances[affiliate];
	}

	function lockedAffiliateBalances(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().lockedAffiliateBalances[affiliate];
	}

	function creditLineManagers(address affiliate) external view returns (address) {
		return ExpressProviderStorage.layout().creditLineManagers[affiliate];
	}

	// ── Per-user state ──

	function nonces(address user) external view returns (uint256) {
		return ExpressProviderStorage.layout().nonces[user];
	}

	function getWithdrawInfo(address user, uint256 requestId) external view returns (WithdrawInfo memory) {
		return ExpressProviderStorage.layout().withdrawInfos[user][requestId];
	}

	// ── Ring buffer config ──

	function bucketDuration() external view returns (uint256) {
		return ExpressProviderStorage.layout().bucketDuration;
	}

	function schedulingWindow() external view returns (uint256) {
		return ExpressProviderStorage.layout().schedulingWindow;
	}

	function generalAnchorTimestamp() external view returns (uint256) {
		return ExpressProviderStorage.layout().generalRing.anchorTimestamp;
	}

	function generalStartIndex() external view returns (uint256) {
		return ExpressProviderStorage.layout().generalRing.startIndex;
	}

	function affiliateAnchorTimestamp(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().affiliateRings[affiliate].anchorTimestamp;
	}

	function affiliateStartIndex(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().affiliateRings[affiliate].startIndex;
	}

	function numBuckets() external view returns (uint256) {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		return LibRingBuffer.numBuckets(s.schedulingWindow, s.bucketDuration);
	}

	// ── Security ──

	function securityWindow() external view returns (uint256) {
		return ExpressProviderStorage.layout().securityWindow;
	}

	function tolerancePeriod() external view returns (uint256) {
		return ExpressProviderStorage.layout().tolerancePeriod;
	}

	// ── Fees ──

	function affiliateConfigs(address affiliate) external view returns (uint256 feeRate, uint256 operatorFee) {
		AffiliateConfig storage cfg = ExpressProviderStorage.layout().affiliateConfigs[affiliate];
		return (cfg.feeRate, cfg.operatorFee);
	}

	function collectedFees(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().collectedFees[affiliate];
	}

	function collectedOperatorFees(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().collectedOperatorFees[affiliate];
	}

	// ── Sponsorship ──

	function sponsorBalances(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().sponsorBalances[affiliate];
	}

	function sponsors(address affiliate) external view returns (address) {
		return ExpressProviderStorage.layout().sponsors[affiliate];
	}

	function sponsorConfigs(address affiliate) external view returns (uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount) {
		SponsorConfig storage cfg = ExpressProviderStorage.layout().sponsorConfigs[affiliate];
		return (cfg.maxFeePerWithdraw, cfg.maxWithdrawAmount);
	}

	// ── Validators ──

	function minValidatorSignatures() external view returns (uint256) {
		return ExpressProviderStorage.layout().minValidatorSignatures;
	}

	function validatorApprovalTimeout() external view returns (uint256) {
		return ExpressProviderStorage.layout().validatorApprovalTimeout;
	}

	// ── Access control ──

	function hasRole(bytes32 role, address account) external view returns (bool) {
		return LibAccessControl.hasRole(role, account);
	}

	// ── Liquidity availability ──

	/// @notice Estimates the earliest time a pool-funded express withdrawal can be satisfied.
	/// @dev Excludes credit-line capacity (depends on per-request Muon data, not on-chain snapshot).
	function getEarliestExpressAvailability(address affiliate, uint256 amount) external view returns (bool available, uint256 availableAt) {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		RingBuffer storage genRing = s.generalRing;
		RingBuffer storage affRing = s.affiliateRings[affiliate];
		uint256 bd = s.bucketDuration;
		uint256 nb = LibRingBuffer.numBuckets(s.schedulingWindow, bd);

		uint256 genAdvance;
		uint256 affAdvance;
		{
			uint256 genElapsed = block.timestamp > genRing.anchorTimestamp ? block.timestamp - genRing.anchorTimestamp : 0;
			genAdvance = genRing.anchorTimestamp == 0 ? 0 : genElapsed / bd;
			if (genAdvance > nb) genAdvance = nb;

			uint256 affElapsed = block.timestamp > affRing.anchorTimestamp ? block.timestamp - affRing.anchorTimestamp : 0;
			affAdvance = affRing.anchorTimestamp == 0 ? 0 : affElapsed / bd;
			if (affAdvance > nb) affAdvance = nb;
		}

		uint256 deficit;
		{
			uint256 baseAvailable = s.generalBalance - s.lockedGeneralBalance;
			if (affiliate != address(0)) {
				baseAvailable += s.affiliateBalances[affiliate] - s.lockedAffiliateBalances[affiliate];
			}

			if (baseAvailable >= amount) {
				return (true, block.timestamp);
			}
			deficit = amount - baseAvailable;
		}

		uint256 walkLen;
		uint256 genStart;
		uint256 affStart;
		{
			genStart = (genRing.startIndex + genAdvance) % nb;
			affStart = (affRing.startIndex + affAdvance) % nb;
			uint256 genRemaining = nb - genAdvance;
			uint256 affRemaining = nb - affAdvance;
			walkLen = genRemaining < affRemaining ? genRemaining : affRemaining;
		}

		uint256 totalInflow = 0;
		uint256 totalOutflow = 0;

		for (uint256 i = 0; i < walkLen; i++) {
			{
				uint256 genIdx = (genStart + i) % nb;
				totalInflow += genRing.buckets[genIdx].expectedInflow;
				totalOutflow += genRing.buckets[genIdx].reservedOutflow;
			}
			{
				uint256 affIdx = (affStart + i) % nb;
				totalInflow += affRing.buckets[affIdx].expectedInflow;
				totalOutflow += affRing.buckets[affIdx].reservedOutflow;
			}

			if (totalInflow >= totalOutflow + deficit) {
				return (true, genRing.anchorTimestamp + (genAdvance + i + 1) * bd);
			}
		}

		return (false, 0);
	}
}
