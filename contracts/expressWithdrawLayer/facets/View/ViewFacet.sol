// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IViewFacet } from "./IViewFacet.sol";
import { AffiliateConfig, SponsorConfig } from "../../types/ConfigTypes.sol";
import { WithdrawInfo } from "../../types/WithdrawTypes.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";

import { ExpressProviderStorage } from "../../storages/ExpressProviderStorage.sol";

/// @title ViewFacet
/// @notice Read-only facet exposing all state getters for the ExpressProvider diamond.
contract ViewFacet is IViewFacet {
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

	function minValidatorSignatures(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().minValidatorSignatures[affiliate];
	}

	function validatorApprovalTimeout(address affiliate) external view returns (uint256) {
		return ExpressProviderStorage.layout().validatorApprovalTimeout[affiliate];
	}

	function isValidator(address affiliate, address validator) external view returns (bool) {
		return ExpressProviderStorage.layout().validators[affiliate][validator];
	}

	// ── Access control ──

	function hasRole(bytes32 role, address account) external view returns (bool) {
		return LibAccessControl.hasRole(role, account);
	}
}
