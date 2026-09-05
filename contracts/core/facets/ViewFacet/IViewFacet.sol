// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LiquidationDetail, LiquidationSettlementState } from "../../storages/AccountStorage.sol";
import { CrossLiquidationDetail, PartyATakeoverDetail } from "../../storages/ClearingHouseStorage.sol";
import { BindState } from "../../storages/TradingModeStorage.sol";
import { VirtualExternalTransferRequest } from "../../storages/ExternalTransferStorage.sol";
import { BridgeTransaction } from "../../storages/BridgeStorage.sol";
import { IMuonSignatureVerifier, MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";
import { WithdrawRequest } from "../../storages/WithdrawStorage.sol";
import { EntityMetadata } from "../../storages/MAStorage.sol";
import { Fee } from "../../storages/QuoteStorage.sol";

interface IViewFacet {
	function pendingOwner() external view returns (address);

	function getOwner() external view returns (address);

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

	function maxDeallocatableForPartyA(address partyA, int256 upnl) external view returns (uint256);

	function maxSafeDeallocatableForPartyA(address partyA, int256 upnl, uint256 pendingBalance, uint256 fundingDebt) external view returns (uint256);

	function maxDeallocatableForPartyB(address partyB, address partyA, int256 upnl) external view returns (uint256);

	function maxRemovableMarginForPartyA(
		address partyA,
		int256 upnl,
		uint256 pendingBalance,
		uint256 scaledLockedBalance,
		uint256 fundingDebt
	) external view returns (uint256);

	function maxRemovableMarginForPartyB(
		address partyB,
		address partyA,
		int256 upnl,
		uint256 pendingBalance,
		uint256 scaledLockedBalance,
		uint256 fundingDebt
	) external view returns (uint256);

	function isCrossPartyB(address partyB) external view returns (bool);

	function isLegacyDeallocateDeprecated() external view returns (bool);

	function allocatedBalanceOfPartyBs(address partyA, address[] memory partyBs) external view returns (uint256[] memory);

	function balanceOfReserveVault(address partyB) external view returns (uint256);

	function withdrawCooldownOf(address user) external view returns (uint256);

	function getWithdrawableTime(address user) external view returns (uint256);

	function nonceOfPartyA(address partyA) external view returns (uint256);

	function nonceOfPartyB(address partyB, address partyA) external view returns (uint256);

	function upnlCounterOfPartyA(address partyA) external view returns (uint256);

	function upnlCounterOfPartyB(address partyB, address partyA) external view returns (uint256);

	function isSuspended(address user) external view returns (bool);

	function getLiquidatedStateOfPartyA(address partyA) external view returns (LiquidationDetail memory);

	function getDeallocateDebounceTime() external view returns (uint256);

	function getInvalidBridgedAmountsPool() external view returns (address);

	function getSettlementStates(address partyA, address[] memory partyBs) external view returns (LiquidationSettlementState[] memory);

	// Role
	function hasRole(address user, bytes32 role) external view returns (bool);

	function isRoleAdmin(address account, bytes32 role) external view returns (bool);

	function getRoleHash(string memory str) external pure returns (bytes32);

	// MA
	function getCollateral() external view returns (address);

	function getFeeCollector(address affiliate) external view returns (address);

	function getDefaultFeeCollector() external view returns (address);

	function getOperationalFeeReceiver(address charger) external view returns (address);

	function getSolverFeeReceiver(address partyB) external view returns (address);

	function getSolverFeeReceiverForTag(address partyB, bytes32 tag) external view returns (address);

	function getOperationalFeeAllowance(
		address payer,
		address charger
	) external view returns (uint256 allowance, uint256 pendingAllowance, uint256 reductionReadyAt, uint256 feeMultiplier);

	function isOperationalFeeCharger(address charger) external view returns (bool);

	function isCrossPartyBModeActivated() external view returns (bool);

	function isLegacyPartyALiquidationDeprecated() external view returns (bool);

	function isPartyALiquidated(address partyA) external view returns (bool);

	function isPartyBLiquidated(address partyB, address partyA) external view returns (bool);

	function isPartyB(address user) external view returns (bool);

	function isAffiliate(address affiliate) external view returns (bool);

	function pendingQuotesValidLength() external view returns (uint256);

	function forceClosePricePenalty() external view returns (uint256);

	function forceCloseMinSigPeriod() external view returns (uint256);

	function liquidatorShare() external view returns (uint256);

	function liquidationTimeout() external view returns (uint256);

	function liquidationStartPositionCount(address partyA) external view returns (uint256);

	function partyBLiquidationTimestamp(address partyB, address partyA) external view returns (uint256);

	function coolDownsOfMA() external view returns (uint256, uint256, uint256, uint256);

	function forceCloseCooldowns() external view returns (uint256, uint256);

	function deallocateCooldown() external view returns (uint256);

	function settlementCooldown() external view returns (uint256);

	function unbindCooldown() external view returns (uint256);

	function deactiveInstantActionModeCooldown() external view returns (uint256);

	function lastUpnlSettlementTimestamp(address senderPartyB, address targetPartyB, address partyA) external view returns (uint256);

	function maxConnectedCounterParty() external view returns (uint256);

	function isCallFromInstantLayer() external view returns (bool);

	function getMuonConfig() external view returns (uint256 upnlValidTime, uint256 priceValidTime);

	/// @notice Returns the effective UPNL validity for a Muon function and whether it comes from an override.
	/// @dev When isOverridden is false, upnlValidTime is the global value from getMuonConfig.
	function getMuonFunctionUpnlValidTime(MuonFunction func) external view returns (uint256 upnlValidTime, bool isOverridden);

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
			bool partyBOpenPositionsPaused,
			bool withdrawAdvancePaused
		);

	function getPartyBEmergencyStatus(address partyB) external view returns (bool isEmergency);

	function isPartyBOpenPositionsPaused(address partyB) external view returns (bool isPaused);

	function isAffiliateShutdownScheduled(address affiliate) external view returns (bool isScheduled);

	function getAffiliateShutdownTime(address affiliate) external view returns (uint256 shutdownTime);

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

	function isPartyBStrictDeallocationEnabled(address partyB) external view returns (bool);

	function getSigner() external view returns (address);

	function getFeeForUser(address affiliate, address user, uint256 symbolId) external view returns (Fee memory fee);

	function getWithdrawRequests(address user, uint256 requestId) external view returns (WithdrawRequest memory);

	function getLastWithdrawRequestId(address user) external view returns (uint256);

	function getWithdrawRequestsBatch(address user, uint256 start, uint256 size) external view returns (WithdrawRequest[] memory);

	function getPendingWithdrawRequests(address user, uint256 start, uint256 size) external view returns (WithdrawRequest[] memory);

	function isExpressProviderRegistered(address provider) external view returns (bool);

	function isVirtualProviderRegistered(address provider) external view returns (bool);

	function isSpeedUpEligible(address user) external view returns (bool);

	function getModifiedCooldownEndTime(address user, uint256 requestId) external view returns (uint256);

	function getWithdrawLockedBalance() external view returns (uint256);

	function getAffiliateFeeForUser(address affiliate, address user, uint256 symbolId) external view returns (Fee memory);

	function getMinAffiliateFee() external view returns (uint256);

	function getVirtualExternalTransfer(uint256 id) external view returns (VirtualExternalTransferRequest memory);

	function getEntityMetadata(address entity) external view returns (EntityMetadata memory);

	function getSoftLiquidationPenaltyCollector() external view returns (address);

	function isBindable(address partyB) external view returns (bool);

	function isLegacyFundingDeprecated() external view returns (bool);

	function isAccumulatedFundingActivated() external view returns (bool);

	function partyAReimbursement(address partyA) external view returns (uint256);

	function getPartyADeferredBalance(address partyA) external view returns (uint256);

	function getLiquidationEscrow(address partyA) external view returns (uint256);

	function getPartyBLiquidationSettlementReserve(address partyB) external view returns (uint256);

	function getPartyATakeoverDetails(address partyA) external view returns (PartyATakeoverDetail memory);

	function isPartyATakeoverInProgress(address partyA) external view returns (bool);

	function getMaxWithdrawParts() external view returns (uint256);

	function getMinWithdrawCooldown() external view returns (uint256);

	function getPureVirtualCancelBlackout() external view returns (uint256);

	function getLastExternalTransferId() external view returns (uint256);
}
