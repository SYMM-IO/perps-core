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

	function generalBadDebt() external view returns (uint256);

	function paused() external view returns (bool);

	// ── Per-user state ──

	function nonces(address user) external view returns (uint256);

	function getWithdrawInfo(address user, uint256 requestId) external view returns (WithdrawInfo memory);

	function accelerateNonce(address user, uint256 requestId) external view returns (uint256);

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

	// ── Credit line ──

	function creditLineSignatureVerifier() external view returns (address);

	function creditLineMuonAppId() external view returns (uint256);

	function creditLineMuonFreshnessWindow() external view returns (uint256);

	function creditLineProtocolMaxDebt(address affiliate) external view returns (uint256);

	function creditLineProtocolMaxDebtBps(address affiliate) external view returns (uint256);

	function creditLineAffiliateMaxDebt(address affiliate) external view returns (uint256);

	function creditLineAffiliateMaxDebtBps(address affiliate) external view returns (uint256);

	function creditLineReservedDebt(address affiliate) external view returns (uint256);

	function creditLineActiveDebt(address affiliate) external view returns (uint256);

	function creditLineTotalDebt(address affiliate) external view returns (uint256);

	function creditLineRequestDebt(address affiliate, address user, uint256 requestId) external view returns (uint256);

	function creditLineRequestActivated(address affiliate, address user, uint256 requestId) external view returns (bool);

	function creditLinePaused(address affiliate) external view returns (bool);

	function creditLineBlacklisted(address affiliate, address user) external view returns (bool);

	function creditLineBadDebt(address affiliate) external view returns (uint256);

	// ── Cap-change fee / throttle ──

	function capChangeFeeConfig() external view returns (address feeToken, uint256 feeAmount, address feeReceiver);

	function capChangeQuotaConfig() external view returns (uint256 maxFreePerWindow, uint256 windowDuration);

	function capChangeAffiliateState(
		address affiliate
	) external view returns (uint256 count, uint256 epochStart, uint256 remainingFree, uint256 nextResetAt);
}
