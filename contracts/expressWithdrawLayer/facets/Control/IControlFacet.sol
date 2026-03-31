// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IControlEvents } from "./IControlEvents.sol";

interface IControlFacet is IControlEvents {
	// ── Config setters ──

	function setCreditLineManager(address affiliate, address manager) external;

	function setSecurityWindow(uint256 _securityWindow) external;

	function setTolerancePeriod(uint256 _tolerancePeriod) external;

	function setMinValidatorSignatures(address affiliate, uint256 _minValidatorSignatures) external;

	function setValidatorApprovalTimeout(address affiliate, uint256 _timeout) external;

	function setValidator(address affiliate, address validator, bool enabled) external;

	function setAffiliateConfig(address affiliate, uint256 feeRate, uint256 _operatorFee) external;

	// ── Fee claims ──

	function claimFees(address affiliate, address to) external;

	function claimOperatorFees(address affiliate, address to) external;

	// ── Sponsor management ──

	function depositSponsorBalance(address affiliate, uint256 amount) external;

	function withdrawSponsorBalance(address affiliate, uint256 amount, address to) external;

	function setSponsorConfig(address affiliate, uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount) external;

	// ── General pool ──

	function depositToGeneral(uint256 amount) external;

	function withdrawFromGeneral(uint256 amount) external;

	// ── Affiliate pool ──

	function depositToAffiliate(address affiliate, uint256 amount) external;

	function withdrawFromAffiliate(address affiliate, uint256 amount) external;

	// ── Role management (owner only) ──

	function grantRole(bytes32 role, address account) external;

	function revokeRole(bytes32 role, address account) external;

	// ── Ownership ──

	function owner() external view returns (address);

	function pendingOwner() external view returns (address);

	function transferOwnership(address _newOwner) external;

	function acceptOwnership() external;

	function cancelOwnershipTransfer() external;
}
