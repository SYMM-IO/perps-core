// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./IControlEvents.sol";

interface IControlFacet is IControlEvents {
	function transferOwnership(address owner) external;

	function cancelOwnershipTransfer() external;

	function acceptOwnership() external;

	function setAdmin(address user) external;

	function grantRole(address user, bytes32 role) external;

	function revokeRole(address user, bytes32 role) external;

	function addRoleAdmin(bytes32 role, address admin) external;

	function removeRoleAdmin(bytes32 role, address admin) external;

	function registerPartyB(address partyB) external;

	function deregisterPartyB(address partyB, uint256 index) external;

	function registerAffiliate(address affiliate) external;

	function deregisterAffiliate(address affiliate) external;

	function setMuonConfig(uint256 upnlValidTime, uint256 priceValidTime) external;

	function setMuonIds(uint256 muonAppId) external;

	function setCollateral(address collateral) external;

	// CoolDowns

	function setDeallocateCooldown(uint256 deallocateCooldown) external;

	function setForceCancelCooldown(uint256 forceCancelCooldown) external;

	function setForceCloseCooldowns(uint256 forceCloseFirstCooldown, uint256 forceCloseSecondCooldown) external;

	function setForceClosePricePenalty(uint256 forceClosePricePenalty) external;

	function setForceCloseMinSigPeriod(uint256 forceCloseMinSigPeriod) external;

	function setForceCancelCloseCooldown(uint256 forceCancelCloseCooldown) external;

	function setLiquidatorShare(uint256 liquidatorShare) external;

	function setForceCloseGapRatio(uint256 symbolId, uint256 forceCloseGapRatio) external;

	function setPendingQuotesValidLength(uint256 pendingQuotesValidLength) external;

	function setDeallocateDebounceTime(uint256 deallocateDebounceTime) external;

	function setInvalidBridgedAmountsPool(address pool) external;

	function setSettlementCooldown(uint256 settlementCooldown) external;

	function setUnbindCooldown(uint256 unbindCooldown) external;

	function setFeeCollector(address affiliate, address feeCollector) external;

	function setLiquidationTimeout(uint256 liquidationTimeout) external;

	function setBalanceLimitPerUser(uint256 balanceLimitPerUser) external;

	function addBridge(address bridge) external;

	function removeBridge(address bridge) external;

	function setLiquidationInsuranceVaultParams(address insuranceVault, uint256 maxLiquidationProfit) external;

	function setSignatureVerifierAddress(address signatureVerifier) external;

	function addRelayerForExternalTransferTarget(address target, address relayer) external;

	function removeRelayerForExternalTransferTarget(address target) external;

	function registerHook(address affiliate, address hook) external;

	function setADLEnabled(address partyB, bool enabled) external;

	function setCallFromInstantLayer(bool callFromInstantLayer) external;

	function setCustomAffiliateFee(address affiliate,address user, uint256 symbolId, uint256 openFee, uint256 closeFee) external;

	function setAffiliateFee(address affiliate, uint256 symbolId, uint256 openFee, uint256 closeFee) external;

	function setMinAffiliateFee(uint256 minAffiliateFee) external;

	function setDefaultAffiliateFee(address affiliate, uint256 openFee, uint256 closeFee) external;

	function setDefaultFeeCollector(address feeCollector) external;

	function setAffiliateMetadata(address affiliate, EntityMetadata memory metadata) external;

	function setPartyBMetadata(address partyB, EntityMetadata memory metadata) external;

	function setMaxPartyAConnectionLimit(uint256 maxLimit) external;

	function setMaxDeallocateWithdrawCooldownPeriod(uint256 _withdrawCooldownPeriod) external;

	function setMaxWithdrawParts(uint256 _maxWithdrawParts) external;

	function setWithdrawCooldownPeriod(uint256 _withdrawCooldownPeriod) external;

	function registerVirtualProvider(address provider) external;

	function unregisterVirtualProvider(address provider) external;

	function registerExpressProvider(address provider) external;

	function unregisterExpressProvider(address provider) external;

	function setSpeedUpUser(address user) external;

	function unsetSpeedUpUser(address user) external;

	function setMinWithdrawCooldown(uint256 cooldown) external;

	function setSigner(address signer) external;

	function setPenaltyCollector(address penaltyCollector) external;
}
