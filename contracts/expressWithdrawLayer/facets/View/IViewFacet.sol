// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawInfo } from "../../types/WithdrawTypes.sol";

/// @notice Read-only interface exposing all state getters for the ExpressProvider diamond.
interface IViewFacet {
	// ── Core addresses ──

	function symmio() external view returns (address);

	function collateral() external view returns (address);

	// ── Pool balances ──

	function generalBalance() external view returns (uint256);

	function lockedGeneralBalance() external view returns (uint256);

	function affiliateBalances(address affiliate) external view returns (uint256);

	function lockedAffiliateBalances(address affiliate) external view returns (uint256);

	function creditLineManagers(address affiliate) external view returns (address);

	// ── Per-user state ──

	function nonces(address user) external view returns (uint256);

	function getWithdrawInfo(address user, uint256 requestId) external view returns (WithdrawInfo memory);

	// ── Security ──

	function securityWindow() external view returns (uint256);

	function tolerancePeriod() external view returns (uint256);

	// ── Fees ──

	function affiliateConfigs(address affiliate) external view returns (uint256 feeRate, uint256 operatorFee);

	function collectedFees(address affiliate) external view returns (uint256);

	function collectedOperatorFees(address affiliate) external view returns (uint256);

	// ── Sponsorship ──

	function sponsorBalances(address affiliate) external view returns (uint256);

	function sponsors(address affiliate) external view returns (address);

	function sponsorConfigs(address affiliate) external view returns (uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount);

	// ── Validators ──

	function minValidatorSignatures(address affiliate) external view returns (uint256);

	function validatorApprovalTimeout(address affiliate) external view returns (uint256);

	function isValidator(address affiliate, address validator) external view returns (bool);

	// ── Access control ──

	function hasRole(bytes32 role, address account) external view returns (bool);
}
