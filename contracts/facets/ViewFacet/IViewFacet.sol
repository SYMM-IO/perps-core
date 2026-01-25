// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LiquidationDetail, SettlementState, CrossLiquidationDetail, BindState, ExternalTransferReq } from "../../storages/AccountStorage.sol";
import { BridgeTransaction } from "../../storages/BridgeStorage.sol";
import { IMuonSignatureVerifier } from "../../interfaces/IMuonSignatureVerifier.sol";
import { WithdrawRequest } from "../../storages/WithdrawStorage.sol";
import { EntityMetadata } from "../../storages/MAStorage.sol";
import { Fee } from "../../storages/QuoteStorage.sol";

interface IViewFacet {
	function pendingOwner() external view returns (address);

	function owner() external view returns (address);

	// Account
	function balanceOf(address user) external view returns (uint256);

	function partyAStats(
		address partyA
	)
		external
		view
		returns (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256);

	function balanceInfoOfPartyA(
		address partyA
	) external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256);

	function balanceInfoOfPartyB(
		address partyB,
		address partyA
	) external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256);

	function allocatedBalanceOfPartyA(address partyA) external view returns (uint256);

	function isInMasterAccountMode(address partyB) external view returns (bool);

	function isLegacyDeallocateDisabled() external view returns (bool);

	function isMasterAccountMigrationComplete(address partyB) external view returns (bool);

	function allocatedBalanceOfPartyBs(address partyA, address[] memory partyBs) external view returns (uint256[] memory);

	function withdrawCooldownOf(address user) external view returns (uint256);

	function nonceOfPartyA(address partyA) external view returns (uint256);

	function nonceOfPartyB(address partyB, address partyA) external view returns (uint256);

	function isSuspended(address user) external view returns (bool);

	function getLiquidatedStateOfPartyA(address partyA) external view returns (LiquidationDetail memory);

	function getDeallocateDebounceTime() external view returns (uint256);

	function getInvalidBridgedAmountsPool() external view returns (address);

	function getSettlementStates(address partyA, address[] memory partyBs) external view returns (SettlementState[] memory);

	// Role
	function hasRole(address user, bytes32 role) external view returns (bool);

	function isRoleAdmin(address account, bytes32 role) external view returns (bool);

	function getRoleHash(string memory str) external pure returns (bytes32);

	// MA
	function getCollateral() external view returns (address);

	function getFeeCollector(address affiliate) external view returns (address);

	function getDefaultFeeCollector() external view returns (address);

	function isMasterAccountEnabled() external view returns (bool);

	function isPartyALiquidated(address partyA) external view returns (bool);

	function isPartyBLiquidated(address partyB, address partyA) external view returns (bool);

	function isPartyB(address user) external view returns (bool);

	function isAffiliate(address affiliate) external view returns (bool);

	function pendingQuotesValidLength() external view returns (uint256);

	function forceClosePricePenalty() external view returns (uint256);

	function forceCloseMinSigPeriod() external view returns (uint256);

	function liquidatorShare() external view returns (uint256);

	function liquidationTimeout() external view returns (uint256);

	function partyBLiquidationTimestamp(address partyB, address partyA) external view returns (uint256);

	function coolDownsOfMA() external view returns (uint256, uint256, uint256, uint256);

	function forceCloseCooldowns() external view returns (uint256, uint256);

	function deallocateCooldown() external view returns (uint256);

	function settlementCooldown() external view returns (uint256);

	function unbindCooldown() external view returns (uint256);

	function lastUpnlSettlementTimestamp(address senderPartyB, address targetPartyB, address partyA) external view returns (uint256);

	function maxConnectedCounterParty() external view returns (uint256);

	function isCallFromInstantLayer() external view returns (bool);

	function getMuonConfig() external view returns (uint256 upnlValidTime, uint256 priceValidTime);

	function getMuonIds() external view returns (uint256 muonAppId);

	function pauseState()
		external
		view
		returns (
			bool globalPaused,
			bool liquidationPaused,
			bool accountingPaused,
			bool partyBActionsPaused,
			bool partyAActionsPaused,
			bool internalTransferPaused,
			bool externalTransferPaused,
			bool emergencyMode,
			bool partyBOpenPositionsPaused
		);

	function getPartyBEmergencyStatus(address partyB) external view returns (bool isEmergency);

	function getBalanceLimitPerUser() external view returns (uint256);

	function verifyMuonTSSAndGateway(bytes32 hash, IMuonSignatureVerifier.SchnorrSign memory sign, bytes memory gatewaySignature) external view;

	function getBridgeTransaction(uint256 transactionId) external view returns (BridgeTransaction memory);

	function getNextBridgeTransactionId() external view returns (uint256);

	function getBridgeTransactions(address bridge, uint256 start, uint256 size) external view returns (BridgeTransaction[] memory);

	function getLiquidationInsuranceVaultParams() external view returns (address, uint256);

	function getPartyBCrossLiquidationStatus(address partyB) external view returns (bool);

	function getCrossLiquidationDetails(address partyB) external view returns (CrossLiquidationDetail memory);

	function getSignatureVerifier() external view returns (address);

	function getBindState(address user) external view returns (BindState memory);

	function getAffiliateHook(address affiliate) external view returns (address hook);

	function getAffiliateFee(address affiliate, uint256 symbolId) external view returns (Fee memory);

	function isADLEnabled(address partyB) external view returns (bool);

	function getSigner() external view returns (address);

	function getFee(address affiliate, uint256 symbolId) external view returns (Fee memory fee);

	function getWithdrawRequests(address user, uint256 requestId) external view returns (WithdrawRequest memory);

	function isExpressProviderRegistered(address provider) external view returns (bool);

	function isVirtualProviderRegistered(address provider) external view returns (bool);

	function isSpeedUpEligible(address user) external view returns (bool);

	function getModifiedCooldownEndTime(address user, uint256 requestId) external view returns (uint256);

	function getWithdrawLockedBalance() external view returns (uint256);

	function getCustomAffiliateFee(address affiliate, address user, uint256 symbolId) external view returns (Fee memory);

	function getMinAffiliateFee() external view returns (uint256);

	function getVirtualExternalTransfer(uint256 id) external view returns (ExternalTransferReq memory);

	function getEntityMetadata(address entity) external view returns (EntityMetadata memory);

	function getSoftLiquidationPenaltyCollector() external view returns (address);

	function getPartyALockedQuotesCount(address user) external view returns (uint256);

	function isBindable(address partyB) external view returns (bool);

	function getIterativeFundingDeprecationFlag() external view returns (bool);

	function getAccumulativeFundingRateActivationFlag() external view returns (bool);
}
