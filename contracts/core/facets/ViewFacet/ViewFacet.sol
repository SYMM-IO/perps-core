// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";
import { LibMuon } from "../../libraries/muon/LibMuon.sol";
import { LibSolvency } from "../../libraries/LibSolvency.sol";
import { AccountStorage, LiquidationDetail, LiquidationSettlementState, ForceCloseDetail } from "../../storages/AccountStorage.sol";
import { ClearingHouseStorage, CrossLiquidationDetail, PartyATakeoverDetail } from "../../storages/ClearingHouseStorage.sol";
import { TradingModeStorage, BindState } from "../../storages/TradingModeStorage.sol";
import { FundingStorage } from "../../storages/FundingStorage.sol";
import { ExternalTransferStorage, VirtualExternalTransferRequest } from "../../storages/ExternalTransferStorage.sol";
import { WithdrawStorage, WithdrawRequest, WithdrawStatus } from "../../storages/WithdrawStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { AffiliateStorage } from "../../storages/AffiliateStorage.sol";
import { MAStorage, EntityMetadata } from "../../storages/MAStorage.sol";
import { QuoteStorage, LockedValues, Fee } from "../../storages/QuoteStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { MuonStorage } from "../../storages/MuonStorage.sol";
import { IMuonSignatureVerifier } from "../../interfaces/IMuonSignatureVerifier.sol";
import { MigrationStorage } from "../../storages/MigrationStorage.sol";
import { BridgeStorage, BridgeTransaction } from "../../storages/BridgeStorage.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LockedValuesOps } from "../../libraries/LibLockedValues.sol";
import { IViewFacet } from "./IViewFacet.sol";

contract ViewFacet is IViewFacet {
	using LockedValuesOps for LockedValues;

	/// @notice Returns the pending owner of the diamond.
	/// @return The address of the pendingOwner.
	function pendingOwner() external view virtual returns (address) {
		return LibDiamond.diamondStorage().pendingOwner;
	}

	/// @notice Returns the owner of the diamond.
	/// @return The address of the owner.
	function owner() external view virtual returns (address) {
		return LibDiamond.diamondStorage().contractOwner;
	}

	/// @notice Returns the balance of the specified user.
	/// @param user The address of the user.
	/// @return The balance of the user.
	function balanceOf(address user) external view returns (uint256) {
		return AccountStorage.layout().balances[user];
	}

	/// @notice Returns various values related to Party A.
	/// @param partyA The address of Party A.
	/// @return liquidationStatus The liquidation status of Party A.
	/// @return allocatedBalances The allocated balances of Party A.
	/// @return lockedCva The locked CVA of Party A.
	/// @return lockedLf The locked liquidation fee of Party A.
	/// @return lockedPartyAmm The locked Party A maintenance margin.
	/// @return lockedPartyBmm The locked Party B maintenance margin.
	/// @return pendingLockedCva The pending locked CVA of Party A.
	/// @return pendingLockedLf The pending locked liquidation fee of Party A.
	/// @return pendingLockedPartyAmm The pending locked Party A maintenance margin.
	/// @return pendingLockedPartyBmm The pending locked Party B maintenance margin.
	/// @return partyAPositionsCount The number of positions held by Party A.
	/// @return partyAPendingQuotesCount The number of pending quotes submitted by Party A.
	/// @return partyANonces The nonces of Party A.
	/// @return quoteIdsCount The total quote IDs associated with Party A.
	function partyAStats(
		address partyA
	)
		external
		view
		returns (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
	{
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		return (
			maLayout.liquidationStatus[partyA],
			accountLayout.allocatedBalances[partyA],
			accountLayout.lockedBalances[partyA].cva,
			accountLayout.lockedBalances[partyA].lf,
			accountLayout.lockedBalances[partyA].partyAmm,
			accountLayout.lockedBalances[partyA].partyBmm,
			accountLayout.pendingLockedBalances[partyA].cva,
			accountLayout.pendingLockedBalances[partyA].lf,
			accountLayout.pendingLockedBalances[partyA].partyAmm,
			accountLayout.pendingLockedBalances[partyA].partyBmm,
			quoteLayout.partyAPositionsCount[partyA],
			quoteLayout.partyAPendingQuotes[partyA].length,
			accountLayout.partyANonces[partyA],
			quoteLayout.quoteIdsOf[partyA].length
		);
	}

	/// @notice Returns balance information of Party A.
	/// @param partyA The address of Party A.
	/// @return allocatedBalances The allocated balances of Party A.
	/// @return lockedCva The locked CVA.
	/// @return lockedLf The locked liquidation fee.
	/// @return lockedPartyAmm The locked Party A maintenance margin.
	/// @return lockedPartyBmm The locked Party B maintenance margin.
	/// @return pendingLockedCva The pending locked CVA.
	/// @return pendingLockedLf The pending locked liquidation fee.
	/// @return pendingLockedPartyAmm The pending locked Party A maintenance margin.
	/// @return pendingLockedPartyBmm The pending locked Party B maintenance margin.
	function balanceInfoOfPartyA(
		address partyA
	) external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		return (
			accountLayout.allocatedBalances[partyA],
			accountLayout.lockedBalances[partyA].cva,
			accountLayout.lockedBalances[partyA].lf,
			accountLayout.lockedBalances[partyA].partyAmm,
			accountLayout.lockedBalances[partyA].partyBmm,
			accountLayout.pendingLockedBalances[partyA].cva,
			accountLayout.pendingLockedBalances[partyA].lf,
			accountLayout.pendingLockedBalances[partyA].partyAmm,
			accountLayout.pendingLockedBalances[partyA].partyBmm
		);
	}

	/// @notice Returns balance information of Party B for a specific Party A.
	/// @param partyB The address of Party B.
	/// @param partyA The address of Party A.
	/// @return allocatedBalances The allocated balances of Party B for Party A.
	/// @return lockedCva The locked CVA.
	/// @return lockedLf The locked liquidation fee.
	/// @return lockedPartyAmm The locked Party A maintenance margin.
	/// @return lockedPartyBmm The locked Party B maintenance margin.
	/// @return pendingLockedCva The pending locked CVA.
	/// @return pendingLockedLf The pending locked liquidation fee.
	/// @return pendingLockedPartyAmm The pending locked Party A maintenance margin.
	/// @return pendingLockedPartyBmm The pending locked Party B maintenance margin.
	function balanceInfoOfPartyB(
		address partyB,
		address partyA
	) external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		return (
			accountLayout.partyBAllocatedBalances[partyB][partyA],
			accountLayout.partyBLockedBalances[partyB][partyA].cva,
			accountLayout.partyBLockedBalances[partyB][partyA].lf,
			accountLayout.partyBLockedBalances[partyB][partyA].partyAmm,
			accountLayout.partyBLockedBalances[partyB][partyA].partyBmm,
			accountLayout.partyBPendingLockedBalances[partyB][partyA].cva,
			accountLayout.partyBPendingLockedBalances[partyB][partyA].lf,
			accountLayout.partyBPendingLockedBalances[partyB][partyA].partyAmm,
			accountLayout.partyBPendingLockedBalances[partyB][partyA].partyBmm
		);
	}

	/// @notice Returns balance information of Party B in cross partyB mode.
	/// @param partyB The address of Party B.
	/// @return allocatedBalances The allocated balances of Party B.
	/// @return lockedCva The locked CVA.
	/// @return lockedLf The locked liquidation fee.
	/// @return lockedPartyAmm The locked Party A maintenance margin.
	/// @return lockedPartyBmm The locked Party B maintenance margin.
	/// @return pendingLockedCva The pending locked CVA.
	/// @return pendingLockedLf The pending locked liquidation fee.
	/// @return pendingLockedPartyAmm The pending locked Party A maintenance margin.
	/// @return pendingLockedPartyBmm The pending locked Party B maintenance margin.
	function balanceInfoOfCrossPartyB(
		address partyB
	) external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		return (
			accountLayout.partyBAllocatedBalances[partyB][address(0)],
			accountLayout.partyBLockedBalances[partyB][address(0)].cva,
			accountLayout.partyBLockedBalances[partyB][address(0)].lf,
			accountLayout.partyBLockedBalances[partyB][address(0)].partyAmm,
			accountLayout.partyBLockedBalances[partyB][address(0)].partyBmm,
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].cva,
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].lf,
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].partyAmm,
			accountLayout.partyBPendingLockedBalances[partyB][address(0)].partyBmm
		);
	}

	/// @notice Returns the allocated balance of Party A.
	/// @param partyA The address of Party A.
	/// @return The allocated balance of Party A.
	function allocatedBalanceOfPartyA(address partyA) external view returns (uint256) {
		return AccountStorage.layout().allocatedBalances[partyA];
	}

	/// @notice Returns the allocated balance of Party B for a specific Party A.
	/// @param partyB The address of Party B.
	/// @param partyA The address of Party A.
	/// @return The allocated balance of Party B for Party A.
	function allocatedBalanceOfPartyB(address partyB, address partyA) external view returns (uint256) {
		return AccountStorage.layout().partyBAllocatedBalances[partyB][partyA];
	}

	/// @notice Returns the balance of cross partyB (aggregated allocated balance).
	/// @param partyB The address of Party B.
	/// @return The aggregated allocated balance of cross partyB.
	function balanceOfCrossPartyB(address partyB) external view returns (uint256) {
		return AccountStorage.layout().partyBAllocatedBalances[partyB][address(0)];
	}

	/// @notice Checks if a party B is a cross partyB.
	/// @param partyB The address of Party B.
	/// @return A boolean indicating whether the party B is a cross partyB.
	function isCrossPartyB(address partyB) external view returns (bool) {
		return MAStorage.layout().crossModeEnabledForPartyB[partyB];
	}

	/// @notice Checks if the legacy deallocate function is deprecated.
	/// @return A boolean indicating whether legacy deallocate is deprecated (true = must use safeDeallocate).
	function isLegacyDeallocateDeprecated() external view returns (bool) {
		return GlobalAppStorage.layout().legacyDeallocateDeprecated;
	}

	/// @notice Checks if a party B has completed cross partyB locked values migration.
	/// @param partyB The address of Party B.
	/// @return A boolean indicating whether the party B has completed locked values migration.
	function isCrossPartyBMigrationComplete(address partyB) external view returns (bool) {
		return MigrationStorage.layout().partyBLockedValuesMigrated[partyB];
	}

	/// @notice Returns the allocated balances of Party Bs for a specific Party A.
	/// @param partyA The address of Party A.
	/// @param partyBs The addresses of Party Bs.
	/// @return allocatedBalances The allocated balances of Party Bs for Party A.
	function allocatedBalanceOfPartyBs(address partyA, address[] memory partyBs) external view returns (uint256[] memory) {
		uint256[] memory allocatedBalances = new uint256[](partyBs.length);
		for (uint256 i = 0; i < partyBs.length; i++) {
			allocatedBalances[i] = AccountStorage.layout().partyBAllocatedBalances[partyBs[i]][partyA];
		}
		return allocatedBalances;
	}

	/// @notice Returns the deallocation timestamp of a user (indicating the most recent time the user executed a deallocation).
	/// @param user The address of the user.
	/// @return The deallocation timestamp of the user.
	function withdrawCooldownOf(address user) external view returns (uint256) {
		return AccountStorage.layout().deallocateTimestamp[user];
	}

	/// @notice Returns the earliest time a user can finalize a non-provider withdrawal initiated now.
	/// @param user The address of the user.
	/// @return The timestamp when finalization becomes possible. Returns block.timestamp if withdrawable now.
	function getWithdrawableTime(address user) external view returns (uint256) {
		uint256 cooldownEnd = AccountStorage.layout().deallocateTimestamp[user] + MAStorage.layout().withdrawCooldownPeriod;
		return cooldownEnd > block.timestamp ? cooldownEnd : block.timestamp;
	}

	/// @notice Returns the nonce of Party A.
	/// @param partyA The address of Party A.
	/// @return The nonce of Party A.
	function nonceOfPartyA(address partyA) external view returns (uint256) {
		return AccountStorage.layout().partyANonces[partyA];
	}

	/// @notice Returns the nonce of Party B for a specific Party A.
	/// @param partyB The address of Party B.
	/// @param partyA The address of Party A.
	/// @return The nonce of Party B for Party A in normal mode or cross partyB mode.
	function nonceOfPartyB(address partyB, address partyA) external view returns (uint256) {
		return AccountStorage.layout().partyBNonces[partyB][partyA];
	}

	/// @notice Checks whether a user is suspended.
	/// @param user The address of the user.
	/// @return A boolean indicating whether the user is suspended.
	function isSuspended(address user) external view returns (bool) {
		return AccountStorage.layout().suspendedAddresses[user];
	}

	/// @notice Returns the liquidated state details of Party A.
	/// @param partyA The address of Party A.
	/// @return The liquidation details of Party A.
	function getLiquidatedStateOfPartyA(address partyA) external view returns (LiquidationDetail memory) {
		return AccountStorage.layout().liquidationDetails[partyA];
	}

	/// @notice Returns the deallocate debounce time.
	/// @return The deallocate debounce time.
	function getDeallocateDebounceTime() external view returns (uint256) {
		return MAStorage.layout().deallocateDebounceTime;
	}

	/// @notice Returns the invalid bridged amounts pool address.
	/// @return The invalid bridged amounts pool address.
	function getInvalidBridgedAmountsPool() external view returns (address) {
		return BridgeStorage.layout().invalidBridgedAmountsPool;
	}

	/// @notice Returns the settlement states of Party B for a specific Party A.
	/// @param partyA The address of Party A.
	/// @param partyBs The addresses of Party Bs.
	/// @return states The settlement states of Party Bs for Party A.
	function getSettlementStates(address partyA, address[] memory partyBs) external view returns (LiquidationSettlementState[] memory) {
		LiquidationSettlementState[] memory states = new LiquidationSettlementState[](partyBs.length);
		for (uint256 i = 0; i < partyBs.length; i++) {
			states[i] = AccountStorage.layout().settlementStates[partyA][partyBs[i]];
		}
		return states;
	}

	/// @notice Returns an array of bridge transactions associated with a bridge.
	/// @param bridge The address of bridge.
	/// @param start The starting index.
	/// @param size The size of the array.
	/// @return An array of bridge transactions.
	function getBridgeTransactions(address bridge, uint256 start, uint256 size) external view returns (BridgeTransaction[] memory) {
		BridgeStorage.Layout storage bridgeLayout = BridgeStorage.layout();

		if (bridgeLayout.bridgeTransactionIds[bridge].length < start + size) {
			size = bridgeLayout.bridgeTransactionIds[bridge].length - start;
		}
		BridgeTransaction[] memory txs = new BridgeTransaction[](size);
		for (uint256 i = start; i < start + size; i++) {
			txs[i - start] = bridgeLayout.bridgeTransactions[bridgeLayout.bridgeTransactionIds[bridge][i]];
		}
		return txs;
	}

	/// @notice Checks if a user has a specific role.
	/// @param user The address of the user.
	/// @param role The role to check.
	/// @return True if the user has the role, false otherwise.
	function hasRole(address user, bytes32 role) external view returns (bool) {
		return GlobalAppStorage.layout().hasRole[user][role];
	}

	/// @notice Checks if a user is admin for a role.
	/// @param user The address of the user.
	/// @param role The role to check.
	/// @return True if the user is an admin for the role, false otherwise.
	function isRoleAdmin(address user, bytes32 role) external view returns (bool) {
		return LibAccessibility.isRoleAdmin(user, role);
	}

	/// @notice Returns the hash of a role string.
	/// @param str The role string.
	/// @return The hash of the role string.
	function getRoleHash(string memory str) external pure returns (bytes32) {
		return keccak256(abi.encodePacked(str));
	}

	/// @notice Returns the address of the collateral contract.
	/// @return The address of the collateral contract.
	function getCollateral() external view returns (address) {
		return GlobalAppStorage.layout().collateral;
	}

	/// @notice Returns the address of the fee collector.
	/// @param affiliate The address of affiliate.
	/// @return The address of the fee collector.
	function getFeeCollector(address affiliate) external view returns (address) {
		return GlobalAppStorage.layout().affiliateFeeCollector[affiliate];
	}

	/// @notice Returns the address of the default fee collector.
	/// @return The address of the default fee collector.
	function getDefaultFeeCollector() external view returns (address) {
		return GlobalAppStorage.layout().defaultFeeCollector;
	}

	/// @notice Indicates whether Party B accounts are allowed to activate cross partyB mode.
	/// @return True if cross partyB functionality is globally enabled, false otherwise.
	function isCrossPartyBModeActivated() external view returns (bool) {
		return GlobalAppStorage.layout().crossPartyBModeActivated;
	}

	/// @notice Checks if a party A is liquidated.
	/// @param partyA The address of party A.
	/// @return True if party A is liquidated, false otherwise.
	function isPartyALiquidated(address partyA) external view returns (bool) {
		return MAStorage.layout().liquidationStatus[partyA];
	}

	/// @notice Checks if a party B of a specific party A is liquidated.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @return True if party B is liquidated for the given party A, false otherwise.
	function isPartyBLiquidated(address partyB, address partyA) external view returns (bool) {
		return MAStorage.layout().partyBLiquidationStatus[partyB][partyA];
	}

	/// @notice Checks if a user is a party B.
	/// @param user The address of the user.
	/// @return True if the user is a party B, false otherwise.
	function isPartyB(address user) external view returns (bool) {
		return MAStorage.layout().partyBStatus[user];
	}

	/// @notice Checks if an address is a registered affiliate.
	/// @param affiliate The address of the affiliate.
	/// @return True if the user is a registered affiliate, false otherwise.
	function isAffiliate(address affiliate) external view returns (bool) {
		return MAStorage.layout().affiliateStatus[affiliate];
	}

	/// @notice Returns the pending quotes valid length.
	/// @return The pending quotes valid length.
	function pendingQuotesValidLength() external view returns (uint256) {
		return MAStorage.layout().pendingQuotesValidLength;
	}

	/// @notice Returns the force close price penalty.
	/// @return The force close price penalty.
	function forceClosePricePenalty() external view returns (uint256) {
		return MAStorage.layout().forceClosePricePenalty;
	}

	/// @notice Returns the force close minimum signature period.
	/// @return The force close minimum signature period.
	function forceCloseMinSigPeriod() external view returns (uint256) {
		return MAStorage.layout().forceCloseMinSigPeriod;
	}

	/// @notice Returns the force close detail structure.
	/// @param forceCloseId The ID of force close.
	/// @return forceCloseStruct The force close structure.
	function forceCloseDetails(uint256 forceCloseId) external view returns (ForceCloseDetail memory forceCloseStruct) {
		forceCloseStruct = AccountStorage.layout().forceCloseDetails[forceCloseId];
	}

	/// @notice Returns the liquidator share.
	/// @return The liquidator share.
	function liquidatorShare() external view returns (uint256) {
		return MAStorage.layout().liquidatorShare;
	}

	/// @notice Returns the liquidation timeout.
	/// @return The liquidation timeout.
	function liquidationTimeout() external view returns (uint256) {
		return MAStorage.layout().liquidationTimeout;
	}

	/// @notice Returns the liquidation timestamp of a party B for a given party A.
	/// @param partyB The address of party B.
	/// @param partyA The address of party A.
	/// @return The liquidation timestamp of party B for the given party A.
	function partyBLiquidationTimestamp(address partyB, address partyA) external view returns (uint256) {
		return MAStorage.layout().partyBLiquidationTimestamp[partyB][partyA];
	}

	/// @notice Returns the cooldowns of the MA.
	/// @return deallocateCooldown The deallocate cooldown.
	/// @return forceCancelCooldown The force cancel cooldown.
	/// @return forceCancelCloseCooldown The force cancel close cooldown.
	/// @return forceCloseFirstCooldown The force close first cooldown.
	function coolDownsOfMA() external view returns (uint256, uint256, uint256, uint256) {
		return (
			MAStorage.layout().withdrawCooldownPeriod,
			MAStorage.layout().forceCancelCooldown,
			MAStorage.layout().forceCancelCloseCooldown,
			MAStorage.layout().forceCloseFirstCooldown
		);
	}

	/// @notice Returns the force close cooldowns.
	/// @return forceCloseFirstCooldown The force close first cooldown.
	/// @return forceCloseSecondCooldown The force close second cooldown.
	function forceCloseCooldowns() external view returns (uint256, uint256) {
		return (MAStorage.layout().forceCloseFirstCooldown, MAStorage.layout().forceCloseSecondCooldown);
	}

	/// @notice Returns the deallocate cooldown.
	/// @return The deallocate cooldown.
	function deallocateCooldown() external view returns (uint256) {
		return MAStorage.layout().withdrawCooldownPeriod;
	}

	/// @notice Returns the settlement cooldown.
	/// @return The settlement cooldown.
	function settlementCooldown() external view returns (uint256) {
		return MAStorage.layout().settlementCooldown;
	}

	/// @notice Returns the unbind cooldown.
	/// @return The unbind cooldown.
	function unbindCooldown() external view returns (uint256) {
		return TradingModeStorage.layout().unbindCooldown;
	}

	/// @notice Returns the last UPNL settlement timestamp.
	/// @param senderPartyB Address of sender partyB.
	/// @param targetPartyB Address of target partyB.
	/// @param partyA Address of partyA.
	/// @return The last UPNL settlement timestamp.
	function lastUpnlSettlementTimestamp(address senderPartyB, address targetPartyB, address partyA) external view returns (uint256) {
		return MAStorage.layout().lastUpnlSettlementTimestamp[senderPartyB][targetPartyB][partyA];
	}

	/// @notice Returns the max connected counter party limit.
	/// @return The max Party A to Party B connection count limit.
	function maxConnectedCounterParty() external view returns (uint256) {
		return MAStorage.layout().maxPartyAConnectionLimit;
	}

	/// @notice Retrieves the configuration parameters of the Muon system.
	/// @return upnlValidTime The validity period of UPNL.
	/// @return priceValidTime The validity period of price.
	function getMuonConfig() external view returns (uint256 upnlValidTime, uint256 priceValidTime) {
		upnlValidTime = MuonStorage.layout().upnlValidTime;
		priceValidTime = MuonStorage.layout().priceValidTime;
	}

	/// @notice Retrieves the Muon application ID.
	/// @return muonAppId The Muon application ID.
	function getMuonIds() external view returns (uint256 muonAppId) {
		muonAppId = MuonStorage.layout().muonAppId;
	}

	/// @notice Retrieves the current pause state of the system.
	/// @return globalPaused The global pause state.
	/// @return liquidationPaused The liquidation pause state.
	/// @return accountingPaused The accounting pause state.
	/// @return partyBActionsPaused The pause state for party B actions.
	/// @return partyAActionsPaused The pause state for party A actions.
	/// @return internalTransferPaused The internal transfer pause state.
	/// @return externalTransferPaused The external transfer pause state.
	/// @return emergencyMode The emergency mode state.
	/// @return partyBOpenPositionsPaused The pause state for party B opening positions and locking quotes.
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
		)
	{
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		return (
			appLayout.globalPaused,
			appLayout.liquidationPaused,
			appLayout.accountingPaused,
			appLayout.partyBActionsPaused,
			appLayout.partyAActionsPaused,
			appLayout.internalTransferPaused,
			ExternalTransferStorage.layout().externalTransferPaused,
			appLayout.emergencyMode,
			appLayout.partyBOpenPositionsPaused
		);
	}

	/// @notice Retrieves the emergency status of a party B.
	/// @param partyB The address of the party B.
	/// @return isEmergency The emergency status of the party B.
	function getPartyBEmergencyStatus(address partyB) external view returns (bool isEmergency) {
		return GlobalAppStorage.layout().partyBEmergencyStatus[partyB];
	}

	/// @notice Retrieves the balance limit per user.
	/// @return The balance limit per user.
	function getBalanceLimitPerUser() external view returns (uint256) {
		return GlobalAppStorage.layout().balanceLimitPerUser;
	}

	/// @notice Verifies the Muon signature of the Muon TSS and gateway.
	/// @param hash The hash to verify.
	/// @param sign The Schnorr signature.
	/// @param gatewaySignature The Muon signature from the gateway.
	function verifyMuonTSSAndGateway(bytes32 hash, IMuonSignatureVerifier.SchnorrSign memory sign, bytes memory gatewaySignature) external view {
		LibMuon.verifyTSSAndGateway(hash, sign, gatewaySignature);
	}

	/// @notice Retrieves the bridge transaction information.
	/// @param transactionId The ID of the bridge transaction.
	/// @return The bridge transaction information.
	function getBridgeTransaction(uint256 transactionId) external view returns (BridgeTransaction memory) {
		return BridgeStorage.layout().bridgeTransactions[transactionId];
	}

	/// @notice Retrieves the last assigned bridge transaction ID.
	/// @return The last assigned bridge transaction ID.
	function getNextBridgeTransactionId() external view returns (uint256) {
		return BridgeStorage.layout().lastId;
	}

	/// @notice Retrieves the params for liquidation insurance vault.
	/// @return liquidationInsuranceVault The address of vault.
	/// @return maxLiquidationProfitPerPosition The max profit from liquidation per position.
	function getLiquidationInsuranceVaultParams() external view returns (address, uint256) {
		return (MAStorage.layout().liquidationInsuranceVault, MAStorage.layout().maxLiquidationProfitPerPosition);
	}

	/// @notice Retrieves the cross liquidation status of a party B.
	/// @param partyB The address of the party B.
	/// @return inProgress The cross liquidation status of the party B.
	function getPartyBCrossLiquidationStatus(address partyB) external view returns (bool) {
		return ClearingHouseStorage.layout().crossLiquidationDetails[partyB].inProgress;
	}

	/// @notice Retrieves the cross liquidation details of a party B.
	/// @param partyB The address of the party B.
	/// @return details The cross liquidation details of the party B.
	function getCrossLiquidationDetails(address partyB) external view returns (CrossLiquidationDetail memory) {
		return ClearingHouseStorage.layout().crossLiquidationDetails[partyB];
	}

	/// @notice Retrieves the signature verifier.
	/// @return The signature verifier address.
	function getSignatureVerifier() external view returns (address) {
		return GlobalAppStorage.layout().signatureVerifier;
	}

	/// @notice Retrieves the bind state of a user.
	/// @param user The address of the user.
	/// @return The bind state of the user.
	function getBindState(address user) external view returns (BindState memory) {
		return TradingModeStorage.layout().bindState[user];
	}

	/// @notice Retrieves the affiliate hook of an affiliate.
	/// @param affiliate The address of the affiliate.
	/// @return hook The affiliate hook address.
	function getAffiliateHook(address affiliate) external view returns (address hook) {
		return AffiliateStorage.layout().affiliateHooks[affiliate];
	}

	/// @notice Retrieves the affiliate fee for a specific user and symbol.
	/// @param affiliate The address of the affiliate.
	/// @param user The address of the user.
	/// @param symbolId The id of the symbol.
	/// @return The affiliate fee for the user.
	function getAffiliateFeeForUser(address affiliate, address user, uint256 symbolId) external view returns (Fee memory) {
		return AffiliateStorage.layout().affiliateFeeForUser[affiliate][user][symbolId];
	}

	/// @notice Retrieves the minimum affiliate fee.
	/// @return The minimum affiliate fee.
	function getMinAffiliateFee() external view returns (uint256) {
		return AffiliateStorage.layout().minAffiliateFee;
	}

	/// @notice Retrieves the affiliate fee of an affiliate.
	/// @param affiliate The address of the affiliate.
	/// @param symbolId The id of the symbol.
	/// @return The affiliate fee of the affiliate.
	function getAffiliateFee(address affiliate, uint256 symbolId) external view returns (Fee memory) {
		return AffiliateStorage.layout().affiliateFee[affiliate][symbolId];
	}

	/// @notice Checks if being called from instant layer.
	/// @return Whether the call is from instant layer.
	function isCallFromInstantLayer() external view returns (bool) {
		return GlobalAppStorage.layout().callFromInstantLayer;
	}

	/// @notice Retrieves the ADL enabled status of a party B.
	/// @param partyB The address of the party B.
	/// @return Whether ADL is enabled for the party B.
	function isADLEnabled(address partyB) external view returns (bool) {
		return MAStorage.layout().adlEnabled[partyB];
	}

	/// @notice Returns the effective signer address, falling back to msg.sender if no signer is set.
	/// @return The signer address.
	function getSigner() external view returns (address) {
		return GlobalAppStorage.layout().signer == address(0) ? msg.sender : GlobalAppStorage.layout().signer;
	}

	/// @notice Returns the effective fee for an affiliate, user, and symbol, using the full resolution priority:
	///         1. affiliateFeeForUser[affiliate][user][symbolId]
	///         2. affiliateFeeForUser[affiliate][user][0]
	///         3. affiliateFee[affiliate][symbolId]
	///         4. affiliateFee[affiliate][0]
	///         5. symbol default tradingFee
	/// @param affiliate The address of the affiliate.
	/// @param user The address of the user (partyA). Pass address(0) to skip user-specific fee levels.
	/// @param symbolId The id of the symbol.
	/// @return fee The resolved fee structure.
	function getFeeForUser(address affiliate, address user, uint256 symbolId) external view returns (Fee memory fee) {
		AffiliateStorage.Layout storage affiliateLayout = AffiliateStorage.layout();
		if (affiliateLayout.affiliateFeeForUser[affiliate][user][symbolId].isSet) {
			fee = affiliateLayout.affiliateFeeForUser[affiliate][user][symbolId];
		} else if (affiliateLayout.affiliateFeeForUser[affiliate][user][0].isSet) {
			fee = affiliateLayout.affiliateFeeForUser[affiliate][user][0];
		} else if (affiliateLayout.affiliateFee[affiliate][symbolId].isSet) {
			fee = affiliateLayout.affiliateFee[affiliate][symbolId];
		} else if (affiliateLayout.affiliateFee[affiliate][0].isSet) {
			fee = affiliateLayout.affiliateFee[affiliate][0];
		} else {
			uint256 symbolTradingFee = SymbolStorage.layout().symbols[symbolId].tradingFee;
			fee = Fee(symbolTradingFee, symbolTradingFee, true);
		}
	}

	/// @notice Retrieves a specific withdraw request of a user by request ID.
	/// @param user The address of the user.
	/// @param requestId The ID of the withdraw request.
	/// @return The withdraw request.
	function getWithdrawRequests(address user, uint256 requestId) external view returns (WithdrawRequest memory) {
		return WithdrawStorage.layout().withdrawRequests[user][requestId];
	}

	/// @notice Retrieves the last assigned withdraw request ID for a user.
	/// @param user The address of the user.
	/// @return The last assigned withdraw request ID (0 means no requests yet).
	function getLastWithdrawRequestId(address user) external view returns (uint256) {
		return WithdrawStorage.layout().lastWithdrawRequestId[user];
	}

	/// @notice Retrieves a batch of withdraw requests for a user.
	/// @param user The address of the user.
	/// @param start The starting request ID (inclusive).
	/// @param size The number of requests to retrieve.
	/// @return An array of withdraw requests.
	function getWithdrawRequestsBatch(address user, uint256 start, uint256 size) external view returns (WithdrawRequest[] memory) {
		WithdrawStorage.Layout storage ws = WithdrawStorage.layout();
		uint256 lastId = ws.lastWithdrawRequestId[user];
		if (start > lastId) {
			return new WithdrawRequest[](0);
		}
		if (start + size - 1 > lastId) {
			size = lastId - start + 1;
		}
		WithdrawRequest[] memory requests = new WithdrawRequest[](size);
		for (uint256 i = 0; i < size; i++) {
			requests[i] = ws.withdrawRequests[user][start + i];
		}
		return requests;
	}

	/// @notice Retrieves unfinished withdraw requests for a user within a paginated range.
	/// @dev Returns requests with status PENDING, PROVIDER_ACCEPTED, CANCEL_REQUESTED, or SUSPENDED.
	///      Skips requests that are COMPLETED, CANCELLED, or PROVIDER_REJECTED.
	/// @param user The address of the user.
	/// @param start The starting request ID (inclusive).
	/// @param size The number of request IDs to scan.
	/// @return An array of unfinished withdraw requests found in the scanned range.
	function getPendingWithdrawRequests(address user, uint256 start, uint256 size) external view returns (WithdrawRequest[] memory) {
		WithdrawStorage.Layout storage ws = WithdrawStorage.layout();
		uint256 lastId = ws.lastWithdrawRequestId[user];
		if (start > lastId) {
			return new WithdrawRequest[](0);
		}
		if (start + size - 1 > lastId) {
			size = lastId - start + 1;
		}
		WithdrawRequest[] memory requests = new WithdrawRequest[](size);
		uint256 count = 0;
		for (uint256 i = start; i < start + size; i++) {
			WithdrawStatus status = ws.withdrawRequests[user][i].status;
			if (status != WithdrawStatus.COMPLETED && status != WithdrawStatus.CANCELLED && status != WithdrawStatus.PROVIDER_REJECTED) {
				requests[count++] = ws.withdrawRequests[user][i];
			}
		}
		assembly ("memory-safe") {
			mstore(requests, count)
		}
		return requests;
	}

	/// @notice Checks if an address is a registered express provider.
	/// @param provider The address of the express provider.
	/// @return True if the address is a registered express provider, false otherwise.
	function isExpressProviderRegistered(address provider) external view returns (bool) {
		return WithdrawStorage.layout().expressProviders[provider];
	}

	/// @notice Checks if an address is a registered virtual provider.
	/// @param provider The address of the virtual provider.
	/// @return True if the address is a registered virtual provider, false otherwise.
	function isVirtualProviderRegistered(address provider) external view returns (bool) {
		return WithdrawStorage.layout().virtualProviders[provider];
	}

	/// @notice Checks if a user is eligible for speed up.
	/// @param user The address of the user.
	/// @return True if the user is eligible for speed up, false otherwise.
	function isSpeedUpEligible(address user) external view returns (bool) {
		return WithdrawStorage.layout().speedUpWhitelist[user];
	}

	/// @notice Retrieves the modified cooldown end time for a withdraw request of a user.
	/// @param user The address of the user.
	/// @param requestId The ID of the withdraw request.
	/// @return The modified cooldown end time.
	function getModifiedCooldownEndTime(address user, uint256 requestId) external view returns (uint256) {
		WithdrawRequest storage request = WithdrawStorage.layout().withdrawRequests[user][requestId];
		require(request.isCooldownModified, "Cooldown not modified");
		return request.cooldownEndTime;
	}

	/// @notice Retrieves the total locked balance for withdrawals.
	/// @return The total locked balance for withdrawals.
	function getWithdrawLockedBalance() external view returns (uint256) {
		return WithdrawStorage.layout().withdrawLockedBalance;
	}

	/// @notice Retrieves the virtual external transfer request for a given ID.
	/// @param id The ID of the virtual external transfer.
	/// @return The virtual external transfer request.
	function getVirtualExternalTransfer(uint256 id) external view returns (VirtualExternalTransferRequest memory) {
		return ExternalTransferStorage.layout().externalTransfers[id];
	}

	/// @notice Retrieves the metadata of an entity (affiliate or partyB).
	/// @param entity The address of the entity.
	/// @return The metadata of the entity.
	function getEntityMetadata(address entity) external view returns (EntityMetadata memory) {
		return MAStorage.layout().entitiesMetadata[entity];
	}

	/// @notice Returns the address that collects soft liquidation penalties.
	/// @return The soft liquidation penalty collector address.
	function getSoftLiquidationPenaltyCollector() external view returns (address) {
		return GlobalAppStorage.layout().softLiquidationPenaltyCollector;
	}

	/// @notice Checks if a party B is bindable for oracle-less trading.
	/// @param partyB The address of Party B.
	/// @return True if the party B is bindable, false otherwise.
	function isBindable(address partyB) external view returns (bool) {
		return TradingModeStorage.layout().isPartyBBindable[partyB];
	}

	/// @notice Checks if legacy per-quote funding is deprecated.
	/// @return True if legacy funding is deprecated, false otherwise.
	function isLegacyFundingDeprecated() external view returns (bool) {
		return FundingStorage.layout().legacyFundingDeprecated;
	}

	/// @notice Checks if accumulated funding mode is activated.
	/// @return True if accumulated funding is activated, false otherwise.
	function isAccumulatedFundingActivated() external view returns (bool) {
		return FundingStorage.layout().accumulatedFundingActivated;
	}

	/// @notice Returns the reimbursement amount for Party A during liquidation.
	/// @param partyA The address of Party A.
	/// @return The reimbursement amount.
	function partyAReimbursement(address partyA) external view returns (uint256) {
		return AccountStorage.layout().partyAReimbursement[partyA];
	}

	/// @notice Returns the takeover details for a Party A liquidation.
	/// @param partyA The address of Party A.
	/// @return The PartyATakeoverDetail struct.
	function getPartyATakeoverDetails(address partyA) external view returns (PartyATakeoverDetail memory) {
		return ClearingHouseStorage.layout().partyATakeoverDetails[partyA];
	}

	/// @notice Calculates the maximum close amount that keeps PartyA at the liquidation threshold.
	/// @dev Use this to preview the result of `fillCloseRequestToLiquidation` before calling it.
	///      This helps frontends determine if a partial close is possible and what amount will be filled.
	/// @param quoteId The ID of the quote with a pending close request.
	/// @param closedPrice The price at which the position would be closed.
	/// @param marketPrice The current market price.
	/// @param upnlPartyA The unrealized PnL of PartyA.
	/// @return maxCloseAmount The maximum amount that can be closed while keeping PartyA solvent.
	/// @return canCloseAll True if the full quantityToClose can be closed without making PartyA insolvent.
	function getMaxCloseAmountToLiquidation(
		uint256 quoteId,
		uint256 closedPrice,
		uint256 marketPrice,
		int256 upnlPartyA
	) external view returns (uint256 maxCloseAmount, bool canCloseAll) {
		return LibSolvency.calculateMaxCloseAmountToLiquidation(quoteId, closedPrice, marketPrice, upnlPartyA);
	}
}
