// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IControlEvents {
	event GeneralDeposit(uint256 amount);
	event GeneralWithdraw(uint256 amount);
	event AffiliateDeposit(address indexed affiliate, uint256 amount);
	event AffiliateWithdraw(address indexed affiliate, uint256 amount);
	event AffiliateConfigUpdated(address indexed affiliate, uint256 feeRate, uint256 operatorFee);
	event FeesClaimed(address indexed affiliate, uint256 amount);
	event SponsorDeposit(address indexed affiliate, uint256 amount);
	event SponsorWithdraw(address indexed affiliate, uint256 amount);
	event SponsorConfigUpdated(address indexed affiliate, uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount);
	event OperatorFeesClaimed(address indexed affiliate, uint256 amount);
	event MinValidatorSignaturesUpdated(address indexed affiliate, uint256 minValidatorSignatures);
	event ValidatorApprovalTimeoutUpdated(address indexed affiliate, uint256 timeout);
	event ValidatorUpdated(address indexed affiliate, address indexed validator, bool enabled);
	event CreditLineProtocolConfigUpdated(address indexed affiliate, uint256 maxDebt, uint256 maxDebtBps);
	event CreditLineMuonConfigUpdated(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow);
	event CreditLineAffiliateConfigUpdated(address indexed affiliate, uint256 maxDebt, uint256 maxDebtBps);
	event CreditLineUserBlacklistUpdated(address indexed affiliate, address indexed user, bool blacklisted);
	event CreditLinePausedUpdated(address indexed affiliate, bool paused);
	event CapChangeFeeConfigUpdated(address feeToken, uint256 feeAmount, address feeReceiver);
	event CapChangeQuotaConfigUpdated(uint256 maxFreePerWindow, uint256 windowDuration);
	event CreditLineAffiliateConfigSelfUpdated(address indexed affiliate, uint256 maxDebt, uint256 maxDebtBps, bool wasDecrease, uint256 feePaid);
	event TokensRescued(address indexed token, address indexed to, uint256 amount);
	event RequestDebtCleared(address indexed affiliate, address indexed user, uint256 indexed requestId, uint256 amount, bool wasActivated);
	event PausedUpdated(bool paused);
}

interface IControlFacet is IControlEvents {
	// ── Config setters ──

	function setSecurityWindow(uint256 _securityWindow) external;

	function setTolerancePeriod(uint256 _tolerancePeriod) external;

	function setMinValidatorSignatures(address affiliate, uint256 _minValidatorSignatures) external;

	function setValidatorApprovalTimeout(address affiliate, uint256 _timeout) external;

	function setValidator(address affiliate, address validator, bool enabled) external;

	function setAffiliateConfig(address affiliate, uint256 feeRate, uint256 _operatorFee) external;

	// ── Credit line setters ──

	function setCreditLineMuonConfig(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow) external;

	function setCreditLineProtocolConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external;

	function setCreditLineAffiliateConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external;

	function setMyCreditLineConfig(uint256 maxDebt, uint256 maxDebtBps) external;

	function setCapChangeFeeConfig(address feeToken, uint256 feeAmount, address feeReceiver) external;

	function setCapChangeQuotaConfig(uint256 maxFreePerWindow, uint256 windowDuration) external;

	function setCreditLinePaused(address affiliate, bool paused) external;

	function setCreditLineBlacklisted(address affiliate, address user, bool blacklisted) external;

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

	// ── Emergency recovery ──

	function rescueTokens(address token, address to, uint256 amount) external;

	function clearRequestDebt(address affiliate, address user, uint256 requestId) external;

	function setPaused(bool value) external;
}
