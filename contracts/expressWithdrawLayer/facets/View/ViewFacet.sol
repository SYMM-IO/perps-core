// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IViewFacet } from "./IViewFacet.sol";
import { AffiliateConfig, SponsorConfig } from "../../types/ConfigTypes.sol";
import { WithdrawInfo } from "../../types/WithdrawTypes.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";

import { AffiliateCredit } from "../../types/CreditTypes.sol";
import { GlobalStorage } from "../../storages/GlobalStorage.sol";
import { PoolStorage } from "../../storages/PoolStorage.sol";
import { FeeStorage } from "../../storages/FeeStorage.sol";
import { ValidatorStorage } from "../../storages/ValidatorStorage.sol";
import { CreditLineStorage } from "../../storages/CreditLineStorage.sol";

/// @title ViewFacet
/// @notice Read-only facet exposing all state getters for the ExpressProvider diamond.
contract ViewFacet is IViewFacet {
	// ── Core addresses ──

	function symmio() external view returns (address) {
		return GlobalStorage.layout().symmio;
	}

	function collateral() external view returns (address) {
		return address(GlobalStorage.layout().collateral);
	}

	// ── Pool balances ──

	function generalBalance() external view returns (uint256) {
		return PoolStorage.layout().generalBalance;
	}

	function lockedGeneralBalance() external view returns (uint256) {
		return PoolStorage.layout().lockedGeneralBalance;
	}

	function affiliateBalances(address affiliate) external view returns (uint256) {
		return PoolStorage.layout().affiliateBalances[affiliate];
	}

	function lockedAffiliateBalances(address affiliate) external view returns (uint256) {
		return PoolStorage.layout().lockedAffiliateBalances[affiliate];
	}

	// ── Per-user state ──

	function nonces(address user) external view returns (uint256) {
		return GlobalStorage.layout().nonces[user];
	}

	function getWithdrawInfo(address user, uint256 requestId) external view returns (WithdrawInfo memory) {
		return GlobalStorage.layout().withdrawInfos[user][requestId];
	}

	// ── Security ──

	function securityWindow() external view returns (uint256) {
		return GlobalStorage.layout().securityWindow;
	}

	function tolerancePeriod() external view returns (uint256) {
		return GlobalStorage.layout().tolerancePeriod;
	}

	// ── Fees ──

	function affiliateConfigs(address affiliate) external view returns (uint256 feeRate, uint256 operatorFee) {
		AffiliateConfig storage cfg = FeeStorage.layout().affiliateConfigs[affiliate];
		return (cfg.feeRate, cfg.operatorFee);
	}

	function collectedFees(address affiliate) external view returns (uint256) {
		return FeeStorage.layout().collectedFees[affiliate];
	}

	function collectedOperatorFees(address affiliate) external view returns (uint256) {
		return FeeStorage.layout().collectedOperatorFees[affiliate];
	}

	// ── Sponsorship ──

	function sponsorBalances(address affiliate) external view returns (uint256) {
		return FeeStorage.layout().sponsorBalances[affiliate];
	}

	function sponsors(address affiliate) external view returns (address) {
		return FeeStorage.layout().sponsors[affiliate];
	}

	function sponsorConfigs(address affiliate) external view returns (uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount) {
		SponsorConfig storage cfg = FeeStorage.layout().sponsorConfigs[affiliate];
		return (cfg.maxFeePerWithdraw, cfg.maxWithdrawAmount);
	}

	// ── Validators ──

	function minValidatorSignatures(address affiliate) external view returns (uint256) {
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		uint256 val = v.minValidatorSignatures[affiliate];
		if (val > 0) return val;
		return v.minValidatorSignatures[address(0)];
	}

	function validatorApprovalTimeout(address affiliate) external view returns (uint256) {
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		uint256 val = v.validatorApprovalTimeout[affiliate];
		if (val > 0) return val;
		return v.validatorApprovalTimeout[address(0)];
	}

	function isValidator(address affiliate, address validator) external view returns (bool) {
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		return v.validators[affiliate][validator] || v.validators[address(0)][validator];
	}

	// ── Access control ──

	function hasRole(bytes32 role, address account) external view returns (bool) {
		return LibAccessControl.hasRole(role, account);
	}

	// ── Credit line ──

	function creditLineSignatureVerifier() external view returns (address) {
		return CreditLineStorage.layout().signatureVerifier;
	}

	function creditLineMuonAppId() external view returns (uint256) {
		return CreditLineStorage.layout().muonAppId;
	}

	function creditLineMuonFreshnessWindow() external view returns (uint256) {
		return CreditLineStorage.layout().muonFreshnessWindow;
	}

	function creditLineProtocolMaxDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].protocolMaxDebt;
	}

	function creditLineProtocolMaxDebtBps(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].protocolMaxDebtBps;
	}

	function creditLineAffiliateMaxDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].affiliateMaxDebt;
	}

	function creditLineAffiliateMaxDebtBps(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].affiliateMaxDebtBps;
	}

	function creditLineReservedDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].reservedDebt;
	}

	function creditLineActiveDebt(address affiliate) external view returns (uint256) {
		return CreditLineStorage.layout().affiliates[affiliate].activeDebt;
	}

	function creditLineTotalDebt(address affiliate) external view returns (uint256) {
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		return ac.reservedDebt + ac.activeDebt;
	}

	function creditLineRequestDebt(address affiliate, address user, uint256 requestId) external view returns (uint256) {
		bytes32 key = keccak256(abi.encodePacked(user, requestId));
		return CreditLineStorage.layout().affiliates[affiliate].requestDebt[key];
	}

	function creditLineRequestActivated(address affiliate, address user, uint256 requestId) external view returns (bool) {
		bytes32 key = keccak256(abi.encodePacked(user, requestId));
		return CreditLineStorage.layout().affiliates[affiliate].requestActivated[key];
	}

	function creditLinePaused(address affiliate) external view returns (bool) {
		return CreditLineStorage.layout().affiliates[affiliate].paused;
	}

	function creditLineBlacklisted(address affiliate, address user) external view returns (bool) {
		return CreditLineStorage.layout().affiliates[affiliate].blacklisted[user];
	}
}
