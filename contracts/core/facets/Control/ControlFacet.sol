// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Ownable } from "../../utils/Ownable.sol";
import { Accessibility } from "../../utils/Accessibility.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { MuonStorage } from "../../storages/MuonStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { SymbolStorage } from "../../storages/SymbolStorage.sol";
import { QuoteStorage } from "../../storages/QuoteStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { IControlFacet } from "./IControlFacet.sol";
import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { BridgeStorage } from "../../storages/BridgeStorage.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { EntityMetadata } from "../../storages/MAStorage.sol";
import { Fee } from "../../storages/QuoteStorage.sol";

contract ControlFacet is Accessibility, Ownable, IControlFacet {
	/// @notice Initiates a two-step ownership transfer to a new address. The new owner must call acceptOwnership() to complete the transfer.
	/// @param owner The address of the pending new owner.
	function transferOwnership(address owner) external onlyOwner {
		checkZeroAddress(owner);
		LibDiamond.transferOwnership(owner);
	}

	/// @notice Cancels the pending ownership transfer.
	function cancelOwnershipTransfer() external onlyOwner {
		LibDiamond.cancelOwnershipTransfer();
	}

	/// @notice Completes the two-step ownership transfer. Must be called by the pending owner set via transferOwnership().
	function acceptOwnership() external {
		LibDiamond.acceptOwnership();
	}

	/// @notice Grants the DEFAULT_ADMIN_ROLE to a user, giving them full administrative privileges over all roles.
	/// @param user The address to grant admin privileges to.
	function setAdmin(address user) external onlyOwner {
		checkZeroAddress(user);
		GlobalAppStorage.layout().hasRole[user][LibAccessibility.DEFAULT_ADMIN_ROLE] = true;
		emit RoleGranted(LibAccessibility.DEFAULT_ADMIN_ROLE, user);
	}

	/// @notice Grants a specified role to a user.
	/// @param user The address to grant the role to.
	/// @param role The bytes32 identifier of the role to grant.
	function grantRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		checkZeroAddress(user);
		if (role == LibAccessibility.LIQUIDATOR_ROLE) {
			require(
				QuoteStorage.layout().partyAPendingQuotes[user].length == 0 && QuoteStorage.layout().partyAOpenPositions[user].length == 0,
				"ControlFacet: PartyA can't become liquidator"
			);
		}
		GlobalAppStorage.layout().hasRole[user][role] = true;
		emit RoleGranted(role, user);
	}

	/// @notice Revokes a specified role from a user, removing their associated permissions.
	/// @param user The address to revoke the role from.
	/// @param role The bytes32 identifier of the role to revoke.
	function revokeRole(address user, bytes32 role) external onlyRoleAdmin(role) {
		GlobalAppStorage.layout().hasRole[user][role] = false;
		emit RoleRevoked(role, user);
	}

	/// @notice Adds an account as admin for a specific role. Role admins can grant and revoke that role to other users.
	/// @param role The bytes32 identifier of the role to add an admin for.
	/// @param admin The address to grant admin privileges for the specified role.
	function addRoleAdmin(bytes32 role, address admin) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		checkZeroAddress(admin);
		GlobalAppStorage.layout().roleAdmins[role][admin] = true;
		emit RoleAdminAdded(role, admin);
	}

	/// @notice Removes an account from the admins for a specific role, revoking their ability to manage that role.
	/// @param role The bytes32 identifier of the role to remove an admin from.
	/// @param admin The address to remove admin privileges from for the specified role.
	function removeRoleAdmin(bytes32 role, address admin) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		checkZeroAddress(admin);
		GlobalAppStorage.layout().roleAdmins[role][admin] = false;
		emit RoleAdminRemoved(role, admin);
	}

	/// @notice Registers a new Party B (market maker/hedger) into the system, allowing them to respond to quotes from Party A users.
	/// @param partyB The address to register as Party B.
	function registerPartyB(address partyB) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		checkZeroAddress(partyB);
		require(!MAStorage.layout().partyBStatus[partyB], "ControlFacet: Address is already registered");
		MAStorage.layout().partyBStatus[partyB] = true;
		MAStorage.layout().partyBList.push(partyB);
		emit RegisterPartyB(partyB);
	}

	/// @notice Deregisters a Party B from the system, preventing them from responding to new quotes.
	/// @param partyB The address of the Party B to deregister.
	/// @param index The index of the Party B in the partyBList array (used for gas-efficient removal).
	function deregisterPartyB(address partyB, uint256 index) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		checkZeroAddress(partyB);
		require(MAStorage.layout().partyBStatus[partyB], "ControlFacet: Address is not registered");
		require(MAStorage.layout().partyBList[index] == partyB, "ControlFacet: Invalid index");
		uint256 lastIndex = MAStorage.layout().partyBList.length - 1;
		require(index <= lastIndex, "ControlFacet: Invalid index");
		MAStorage.layout().partyBStatus[partyB] = false;
		MAStorage.layout().partyBList[index] = MAStorage.layout().partyBList[lastIndex];
		MAStorage.layout().partyBList.pop();
		emit DeregisterPartyB(partyB, index);
	}

	/// @notice Sets the metadata for a Party B, including display name and other identifying information.
	/// @param partyB The address of the Party B to set metadata for.
	/// @param metadata The EntityMetadata struct containing the Party B's metadata.
	function setPartyBMetadata(address partyB, EntityMetadata memory metadata) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		MAStorage.layout().entitiesMetadata[partyB] = metadata;
		emit SetEntityMetadata(partyB, metadata);
	}

	/// @notice Registers a new affiliate (frontend partner) into the system.
	/// @param affiliate The address to register as an affiliate.
	function registerAffiliate(address affiliate) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		require(!MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Address is already registered");
		MAStorage.layout().affiliateStatus[affiliate] = true;
		emit RegisterAffiliate(affiliate);
	}

	/// @notice Deregisters an affiliate from the system, preventing new users from being associated with them.
	/// @param affiliate The address of the affiliate to deregister.
	function deregisterAffiliate(address affiliate) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Address is not registered");
		MAStorage.layout().affiliateStatus[affiliate] = false;
		emit DeregisterAffiliate(affiliate);
	}

	/// @notice Sets the metadata for an affiliate, including display name and other identifying information.
	/// @param affiliate The address of the affiliate to set metadata for.
	/// @param metadata The EntityMetadata struct containing the affiliate's metadata.
	function setAffiliateMetadata(address affiliate, EntityMetadata memory metadata) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		MAStorage.layout().entitiesMetadata[affiliate] = metadata;
		emit SetEntityMetadata(affiliate, metadata);
	}

	/// @notice Sets the validity duration for Muon oracle signatures. Signatures older than these values will be rejected.
	/// @param upnlValidTime The duration in seconds that UPNL (unrealized profit and loss) signatures remain valid.
	/// @param priceValidTime The duration in seconds that price signatures remain valid.
	function setMuonConfig(uint256 upnlValidTime, uint256 priceValidTime) external onlyRole(LibAccessibility.MUON_SETTER_ROLE) {
		emit SetMuonConfig(upnlValidTime, priceValidTime);
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		muonLayout.upnlValidTime = upnlValidTime;
		muonLayout.priceValidTime = priceValidTime;
	}

	/// @notice Sets the Muon application ID used to identify this protocol in the Muon oracle network.
	/// @param muonAppId The unique identifier for this application in the Muon network.
	function setMuonIds(uint256 muonAppId) external onlyRole(LibAccessibility.MUON_SETTER_ROLE) {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		muonLayout.muonAppId = muonAppId;
		emit SetMuonIds(muonAppId);
	}

	/// @notice Sets the ERC20 token used as collateral for all positions. Can only be changed when contract holds no collateral.
	/// @param collateral The address of the ERC20 token to use as collateral (must have <= 18 decimals).
	function setCollateral(address collateral) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		checkZeroAddress(collateral);
		require(IERC20Metadata(collateral).decimals() <= 18, "ControlFacet: Token with more than 18 decimals not allowed");
		if (GlobalAppStorage.layout().collateral != address(0)) {
			require(
				IERC20Metadata(GlobalAppStorage.layout().collateral).balanceOf(address(this)) == 0,
				"ControlFacet: There is still collateral in the contract"
			);
		}
		GlobalAppStorage.layout().collateral = collateral;
		emit SetCollateral(collateral);
	}

	/// @notice Sets the maximum number of pending (unaccepted) quotes a Party A can have at once.
	/// @param pendingQuotesValidLength The maximum number of pending quotes allowed per user.
	function setPendingQuotesValidLength(uint256 pendingQuotesValidLength) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		emit SetPendingQuotesValidLength(MAStorage.layout().pendingQuotesValidLength, pendingQuotesValidLength);
		MAStorage.layout().pendingQuotesValidLength = pendingQuotesValidLength;
	}

	/// @notice Sets the address where trading fees collected for a specific affiliate will be sent.
	/// @param affiliate The address of the affiliate whose fee collector is being set.
	/// @param feeCollector The address that will receive the affiliate's collected fees.
	function setFeeCollector(address affiliate, address feeCollector) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		checkZeroAddress(feeCollector);
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Invalid affiliate");
		emit SetFeeCollector(affiliate, GlobalAppStorage.layout().affiliateFeeCollector[affiliate], feeCollector);
		GlobalAppStorage.layout().affiliateFeeCollector[affiliate] = feeCollector;
	}

	/// @notice Sets the trading fees for a specific affiliate and symbol. Fees are charged when opening and closing positions.
	/// @param symbolIds The list of trading symbol IDs (0 for default fee across all symbols).
	/// @param openFees The list of open fees (in 1e18 precision).
	/// @param closeFees The list of close fees (in 1e18 precision).
	function setAffiliateFee(address affiliate, uint256[] calldata symbolIds, uint256[] calldata openFees, uint256[] calldata closeFees) external {
		address signer = LibSigner.getSigner();
		require(LibAccessibility.hasRole(signer, LibAccessibility.AFFILIATE_MANAGER_ROLE) || signer == affiliate, "ControlFacet: Not authorized");

		uint256 length = symbolIds.length;
		require(length > 0 && openFees.length == length && closeFees.length == length, "ControlFacet: Invalid array length");
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Invalid affiliate");

		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		for (uint256 i = 0; i < length; i++) {
			uint256 openFee = openFees[i];
			uint256 closeFee = closeFees[i];
			require(openFee <= 1e18 && closeFee <= 1e18, "ControlFacet: High fee");
			require(
				openFee >= appLayout.minAffiliateFee && closeFee >= appLayout.minAffiliateFee,
				"ControlFacet: Not allowed to set fee less than threshold"
			);

			uint256 symbolId = symbolIds[i];
			emit SetAffiliateFee(
				affiliate,
				symbolId,
				appLayout.affiliateFee[affiliate][symbolId].openFee,
				openFee,
				appLayout.affiliateFee[affiliate][symbolId].closeFee,
				closeFee
			);
			appLayout.affiliateFee[affiliate][symbolId] = Fee(openFee, closeFee, true);
		}
	}

	/// @notice Sets custom trading fees for a specific user under an affiliate. Allows preferential rates for specific traders.
	/// @param users The list of users to set custom fees for.
	/// @param symbolIds The list of trading symbol IDs (0 for default fee across all symbols).
	/// @param openFees The list of open fees (in 1e18 precision).
	/// @param closeFees The list of close fees (in 1e18 precision).
	function setCustomAffiliateFee(
		address affiliate,
		address[] calldata users,
		uint256[] calldata symbolIds,
		uint256[] calldata openFees,
		uint256[] calldata closeFees
	) external {
		address signer = LibSigner.getSigner();
		require(LibAccessibility.hasRole(signer, LibAccessibility.AFFILIATE_MANAGER_ROLE) || signer == affiliate, "ControlFacet: Not authorized");

		uint256 length = users.length;
		require(
			length > 0 && symbolIds.length == length && openFees.length == length && closeFees.length == length,
			"ControlFacet: Invalid array length"
		);
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Invalid affiliate");

		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();

		for (uint256 i = 0; i < length; i++) {
			uint256 openFee = openFees[i];
			uint256 closeFee = closeFees[i];
			require(openFee <= 1e18 && closeFee <= 1e18, "ControlFacet: High fee");
			require(
				openFee >= appLayout.minAffiliateFee && closeFee >= appLayout.minAffiliateFee,
				"ControlFacet: Not allowed to set fee less than threshold"
			);

			address user = users[i];
			uint256 symbolId = symbolIds[i];
			emit SetCustomAffiliateFee(
				affiliate,
				user,
				symbolId,
				appLayout.customAffiliateFee[affiliate][user][symbolId].openFee,
				openFee,
				appLayout.customAffiliateFee[affiliate][user][symbolId].closeFee,
				closeFee
			);
			appLayout.customAffiliateFee[affiliate][user][symbolId] = Fee(openFee, closeFee, true);
		}
	}

	/// @notice Sets the fallback address for fee collection when an affiliate has no specific fee collector configured.
	/// @param feeCollector The address that will receive fees when no affiliate-specific collector exists.
	function setDefaultFeeCollector(address feeCollector) external onlyRole(LibAccessibility.FEE_ADMIN_ROLE) {
		emit SetDefaultFeeCollector(GlobalAppStorage.layout().defaultFeeCollector, feeCollector);
		GlobalAppStorage.layout().defaultFeeCollector = feeCollector;
	}

	/// @notice Sets the address where invalid or failed bridge transaction amounts are collected for later processing.
	/// @param pool The address of the pool that will hold invalid bridged amounts.
	function setInvalidBridgedAmountsPool(address pool) external onlyRole(LibAccessibility.FEE_ADMIN_ROLE) {
		checkZeroAddress(pool);
		emit SetInvalidBridgedAmountsPool(BridgeStorage.layout().invalidBridgedAmountsPool, pool);
		BridgeStorage.layout().invalidBridgedAmountsPool = pool;
	}

	/// @notice Sets the minimum fee that affiliates must charge. Prevents affiliates from setting fees below protocol requirements.
	/// @param minAffiliateFee The minimum fee percentage (in 1e18 precision) that affiliates can set.
	function setMinAffiliateFee(uint256 minAffiliateFee) external onlyRole(LibAccessibility.FEE_ADMIN_ROLE) {
		emit SetMinAffiliateFee(GlobalAppStorage.layout().minAffiliateFee, minAffiliateFee);
		GlobalAppStorage.layout().minAffiliateFee = minAffiliateFee;
	}

	// CoolDowns //////////////////////////////////////////////////\

	/// @notice Sets the minimum time between consecutive deallocations. Prevents rapid repeated deallocations by the same user.
	/// @param deallocateDebounceTime The minimum time in seconds between deallocations for a single user.
	function setDeallocateDebounceTime(uint256 deallocateDebounceTime) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetDeallocateDebounceTime(MAStorage.layout().deallocateDebounceTime, deallocateDebounceTime);
		MAStorage.layout().deallocateDebounceTime = deallocateDebounceTime;
	}

	/// @notice Sets the waiting period after deallocation before funds can be withdrawn. Allows time for any problem resolution.
	/// @dev Also updates the withdraw cooldown period to maintain consistency.
	/// @param deallocateCooldown The cooldown duration in seconds after deallocation before withdrawal is permitted.
	function setDeallocateCooldown(uint256 deallocateCooldown) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		_updateWithdrawAndDeallocateCooldown(deallocateCooldown);
	}

	/// @notice Sets the waiting period before Party A can force cancel a pending quote that Party B hasn't responded to.
	/// @param forceCancelCooldown The time in seconds a quote must remain pending before force cancellation is allowed.
	function setForceCancelCooldown(uint256 forceCancelCooldown) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetForceCancelCooldown(MAStorage.layout().forceCancelCooldown, forceCancelCooldown);
		MAStorage.layout().forceCancelCooldown = forceCancelCooldown;
	}

	/// @notice Sets the two-stage cooldown periods for force closing positions when Party B is unresponsive.
	/// @param forceCloseFirstCooldown The initial waiting period in seconds before first force close attempt is allowed.
	/// @param forceCloseSecondCooldown The additional waiting period in seconds before final force close at market price.
	function setForceCloseCooldowns(
		uint256 forceCloseFirstCooldown,
		uint256 forceCloseSecondCooldown
	) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetForceCloseCooldowns(
			MAStorage.layout().forceCloseFirstCooldown,
			forceCloseFirstCooldown,
			MAStorage.layout().forceCloseSecondCooldown,
			forceCloseSecondCooldown
		);
		MAStorage.layout().forceCloseFirstCooldown = forceCloseFirstCooldown;
		MAStorage.layout().forceCloseSecondCooldown = forceCloseSecondCooldown;
	}

	/// @notice Sets the price penalty applied against Party B when a position is force closed. Compensates Party A for delays.
	/// @param forceClosePricePenalty The penalty percentage (in 1e18 precision) applied to the closing price against Party B.
	function setForceClosePricePenalty(uint256 forceClosePricePenalty) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		emit SetForceClosePricePenalty(MAStorage.layout().forceClosePricePenalty, forceClosePricePenalty);
		MAStorage.layout().forceClosePricePenalty = forceClosePricePenalty;
	}

	/// @notice Sets the minimum time window during which price signatures must be collected for a valid force close.
	/// @param forceCloseMinSigPeriod The minimum duration in seconds for which price signatures must span.
	function setForceCloseMinSigPeriod(uint256 forceCloseMinSigPeriod) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetForceCloseMinSigPeriod(MAStorage.layout().forceCloseMinSigPeriod, forceCloseMinSigPeriod);
		MAStorage.layout().forceCloseMinSigPeriod = forceCloseMinSigPeriod;
	}

	/// @notice Sets the waiting period before Party A can force cancel a close request that Party B hasn't fulfilled.
	/// @param forceCancelCloseCooldown The time in seconds a close request must remain pending before force cancellation.
	function setForceCancelCloseCooldown(uint256 forceCancelCloseCooldown) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetForceCancelCloseCooldown(MAStorage.layout().forceCancelCloseCooldown, forceCancelCloseCooldown);
		MAStorage.layout().forceCancelCloseCooldown = forceCancelCloseCooldown;
	}

	/// @notice Sets the percentage of liquidation proceeds that go to liquidators as incentive for performing liquidations in partyB liquidation.
	/// @param liquidatorShare The percentage (in 1e18 precision) of liquidation proceeds awarded to liquidators.
	function setLiquidatorShare(uint256 liquidatorShare) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		emit SetLiquidatorShare(MAStorage.layout().liquidatorShare, liquidatorShare);
		MAStorage.layout().liquidatorShare = liquidatorShare;
	}

	/// @notice Sets the minimum oracle price GlobalAppStorage from requested price during force close for a specific symbol.
	/// @param symbolId The ID of the trading symbol to set the gap ratio for.
	/// @param forceCloseGapRatio The minimum oracle price gap from requested price percentage (in 1e18 precision) during force close.
	function setForceCloseGapRatio(
		uint256 symbolId,
		uint256 forceCloseGapRatio
	) external onlyRole(LibAccessibility.FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE) {
		emit SetForceCloseGapRatio(symbolId, SymbolStorage.layout().forceCloseGapRatio[symbolId], forceCloseGapRatio);
		SymbolStorage.layout().forceCloseGapRatio[symbolId] = forceCloseGapRatio;
	}

	/// @notice Sets the minimum time between UPNL settlements. Prevents excessive settlement frequency by Party B that can affect other parties.
	/// @param settlementCooldown The minimum time in seconds between consecutive UPNL settlements.
	function setSettlementCooldown(uint256 settlementCooldown) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetSettlementCooldown(MAStorage.layout().settlementCooldown, settlementCooldown);
		MAStorage.layout().settlementCooldown = settlementCooldown;
	}

	/// @notice Sets the waiting period before Party A can unbind from a Party B after initiating the unbind process.
	/// @param unbindCooldown The time in seconds Party A must wait before completing the unbind from Party B.
	function setUnbindCooldown(uint256 unbindCooldown) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetUnbindCooldown(MAStorage.layout().unbindCooldown, unbindCooldown);
		MAStorage.layout().unbindCooldown = unbindCooldown;
	}

	/// @notice Sets the maximum number of Party B connections a single Party A can have simultaneously.
	/// @param maxLimit The maximum number of Party Bs a Party A can be connected to at once.
	function setMaxPartyAConnectionLimit(uint256 maxLimit) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		require(maxLimit > 0, "ControlFacet: Value must be greater than zero");
		MAStorage.layout().maxPartyAConnectionLimit = maxLimit;
		emit SetMaxPartyAConnectionLimit(maxLimit);
	}

	/// @notice Sets the maximum time allowed for a liquidation to complete.
	/// @param liquidationTimeout The maximum duration in seconds for a liquidation process to complete.
	function setLiquidationTimeout(uint256 liquidationTimeout) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		emit SetLiquidationTimeout(MAStorage.layout().liquidationTimeout, liquidationTimeout);
		MAStorage.layout().liquidationTimeout = liquidationTimeout;
	}

	/// @notice Sets the maximum collateral balance a single user can hold in the protocol. Used for risk management.
	/// @param balanceLimitPerUser The maximum collateral amount (in collateral token units) a user can deposit.
	function setBalanceLimitPerUser(uint256 balanceLimitPerUser) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		emit SetBalanceLimitPerUser(balanceLimitPerUser);
		GlobalAppStorage.layout().balanceLimitPerUser = balanceLimitPerUser;
	}

	/// @notice Enables or disables cross partyB functionality (feature flag for cross partyB mode).
	/// @param enabled True to enable cross partyB functionality, false to disable.
	function setCrossEnabled(bool enabled) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		emit SetCrossEnabled(appLayout.crossEnabled, enabled);
		appLayout.crossEnabled = enabled;
	}

	/// @notice Enables or disables the legacy deallocate function. When disabled, users must use safeDeallocate.
	/// @param disabled True to disable legacy deallocate (requiring safeDeallocate), false to allow legacy deallocate.
	function setLegacyDeallocateDisabled(bool disabled) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		emit SetLegacyDeallocateDisabled(appLayout.legacyDeallocateDisabled, disabled);
		appLayout.legacyDeallocateDisabled = disabled;
	}

	/// @notice Registers a bridge contract.
	/// @param bridge The address of the bridge contract to authorize.
	function addBridge(address bridge) external onlyRole(LibAccessibility.BRIDGE_MANAGER_ROLE) {
		checkZeroAddress(bridge);
		BridgeStorage.layout().bridges[bridge] = true;
		emit AddBridge(bridge);
	}

	/// @notice Deauthorizes a bridge contract.
	/// @param bridge The address of the bridge contract to deauthorize.
	function removeBridge(address bridge) external onlyRole(LibAccessibility.BRIDGE_MANAGER_ROLE) {
		BridgeStorage.layout().bridges[bridge] = false;
		emit RemoveBridge(bridge);
	}

	/// @notice Configures the liquidation insurance vault which caps liquidator profits and collects excess to protect the protocol.
	/// @param insuranceVault The address of the insurance vault that receives excess liquidation profits.
	/// @param maxLiquidationProfit The maximum profit (in collateral token units) a liquidator can earn per position.
	function setLiquidationInsuranceVaultParams(
		address insuranceVault,
		uint256 maxLiquidationProfit
	) external onlyRole(LibAccessibility.FEE_ADMIN_ROLE) {
		checkZeroAddress(insuranceVault);
		MAStorage.Layout storage maLayout = MAStorage.layout();
		maLayout.liquidationInsuranceVault = insuranceVault;
		maLayout.maxLiquidationProfitPerPosition = maxLiquidationProfit;
		emit SetLiquidationInsuranceVaultParams(insuranceVault, maxLiquidationProfit);
	}

	/// @notice Sets the contract address responsible for verifying muon cryptographic signatures in the protocol.
	/// @param signatureVerifier The address of the signature verifier contract.
	function setSignatureVerifierAddress(address signatureVerifier) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		GlobalAppStorage.layout().signatureVerifier = signatureVerifier;
		emit SetSignatureVerifierAddress(signatureVerifier);
	}

	/// @notice Authorizes a relayer to facilitate external transfers to a specific target address (e.g., another protocol contract).
	/// @param target The external transfer destination address that the relayer can transfer funds to.
	/// @param relayer The address authorized to relay transfers to the target.
	function addRelayerForExternalTransferTarget(address target, address relayer) external onlyRole(LibAccessibility.INTEGRATION_ADMIN_ROLE) {
		checkZeroAddress(target);
		AccountStorage.layout().externalTransferTargetsRelayers[target] = relayer;
		emit AddRelayerForExternalTransferTarget(target, relayer);
	}

	/// @notice Removes the authorized relayer for an external transfer target, disabling relayed transfers to that destination.
	/// @param target The external transfer destination address to remove the relayer authorization from.
	function removeRelayerForExternalTransferTarget(address target) external onlyRole(LibAccessibility.INTEGRATION_ADMIN_ROLE) {
		checkZeroAddress(target);
		AccountStorage.layout().externalTransferTargetsRelayers[target] = address(0);
		emit RemoveRelayerForExternalTransferTarget(target);
	}

	/// @notice Registers a hook contract for an affiliate that gets called during specific protocol events.
	/// @param affiliate The address of the affiliate to register the hook for.
	/// @param hook The address of the hook contract to be called for this affiliate's events.
	function registerHook(address affiliate, address hook) external onlyRole(LibAccessibility.INTEGRATION_ADMIN_ROLE) {
		AccountStorage.layout().affiliateHooks[affiliate] = hook;
		emit RegisterHook(affiliate, hook);
	}

	/// @notice Indicates if the current operation is being executed via the instant layer.
	/// @dev instant layer sets this flag to true before execution and MUST reset it back to false after its operation. Core can use this flag to know if this request is coming from instant layer.
	function setCallFromInstantLayer(bool _callFromInstantLayer) external onlyRole(LibAccessibility.INSTANT_LAYER_ROLE) {
		require(!(_callFromInstantLayer && GlobalAppStorage.layout().instantLayerPaused), "ControlFacet: Instant Layer Paused");
		MAStorage.layout().callFromInstantLayer = _callFromInstantLayer;
	}

	/// @notice Enables or disables Auto-Deleveraging (ADL) for a Party B. When enabled, positions can be force-closed to reduce risk.
	/// @param partyB The address of the Party B to configure ADL for.
	/// @param enabled True to enable ADL for this Party B, false to disable.
	function setADLEnabled(address partyB, bool enabled) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		MAStorage.layout().adlEnabled[partyB] = enabled;
		emit SetADLEnabled(partyB, enabled);
	}

	/// @notice Sets the maximum number of partial withdrawals allowed. Withdrawals can be split to manage liquidity.
	/// @param _maxWithdrawParts The maximum number of parts a single withdrawal can be divided into.
	function setMaxWithdrawParts(uint256 _maxWithdrawParts) external onlyRole(LibAccessibility.PROTOCOL_CONFIG_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.maxWithdrawParts = _maxWithdrawParts;
		emit SetMaxWithdrawParts(_maxWithdrawParts);
	}

	/// @notice Sets the waiting period after initiating a withdrawal before funds can be claimed. Provides time for security checks.
	/// @dev Also updates the deallocate cooldown to maintain consistency.
	/// @param _withdrawCooldownPeriod The cooldown duration in seconds before withdrawal can be completed.
	function setWithdrawCooldownPeriod(uint256 _withdrawCooldownPeriod) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		_updateWithdrawAndDeallocateCooldown(_withdrawCooldownPeriod);
	}

	function _updateWithdrawAndDeallocateCooldown(uint256 newValue) internal {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		emit SetWithdrawCooldownPeriod(withdrawLayout.withdrawCooldownPeriod, newValue);
		emit SetDeallocateCooldown(maLayout.deallocateCooldown, newValue);
		withdrawLayout.withdrawCooldownPeriod = newValue;
		maLayout.deallocateCooldown = newValue;
	}

	/// @notice Registers a virtual provider that can facilitate virtual deposits/withdrawals without actual token transfers.
	/// @param provider The address to authorize as a virtual provider.
	function registerVirtualProvider(address provider) external onlyRole(LibAccessibility.PROVIDER_ADMIN_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		require(!appLayout.expressProviders[provider], "ControlFacet: Already a express provider");
		require(!appLayout.virtualProviders[provider], "ControlFacet: Already a virtual provider");
		appLayout.virtualProviders[provider] = true;
		emit RegisterVirtualProvider(provider);
	}

	/// @notice Removes a virtual provider's authorization, preventing them from facilitating virtual deposits/withdrawals.
	/// @param provider The address to remove from authorized virtual providers.
	function unregisterVirtualProvider(address provider) external onlyRole(LibAccessibility.PROVIDER_ADMIN_ROLE) {
		GlobalAppStorage.layout().virtualProviders[provider] = false;
		emit UnregisterVirtualProvider(provider);
	}

	/// @notice Registers an express provider that can facilitate expedited withdrawals with reduced cooldown periods.
	/// @param provider The address to authorize as an express provider.
	function registerExpressProvider(address provider) external onlyRole(LibAccessibility.PROVIDER_ADMIN_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		require(!appLayout.virtualProviders[provider], "ControlFacet: Already a virtual provider");
		require(!appLayout.expressProviders[provider], "ControlFacet: Already a express provider");
		appLayout.expressProviders[provider] = true;
		emit RegisterExpressProvider(provider);
	}

	/// @notice Removes an express provider's authorization, preventing them from facilitating express withdrawals.
	/// @param provider The address to remove from authorized express providers.
	function unregisterExpressProvider(address provider) external onlyRole(LibAccessibility.PROVIDER_ADMIN_ROLE) {
		GlobalAppStorage.layout().expressProviders[provider] = false;
		emit UnregisterExpressProvider(provider);
	}

	/// @notice Adds or removes a user from the speed-up whitelist, allowing them to request speed-up withdrawals with reduced cooldown periods.
	/// @param user The address of the user to modify speed-up status for.
	/// @param speedUp True to enable speed-up withdrawals for the user, false to disable.
	function setSpeedUpUser(address user, bool speedUp) external onlyRole(LibAccessibility.WITHDRAW_SPEED_UP_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.speedUpWhitelist[user] = speedUp;
		emit SetSpeedUpUser(user, speedUp);
	}

	/// @notice Sets the absolute minimum cooldown for withdrawals that cannot be bypassed even by speed-up users.
	/// @param cooldown The minimum cooldown duration in seconds that applies to all withdrawals.
	function setMinWithdrawCooldown(uint256 cooldown) external onlyRole(LibAccessibility.COOLDOWN_ADMIN_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		emit SetMinWithdrawCooldown(withdrawLayout.minWithdrawCooldown, cooldown);
		withdrawLayout.minWithdrawCooldown = cooldown;
	}

	/// @notice Sets the trusted signer address whose signatures are accepted for protocol operations.
	/// @param signer The address of the trusted signer for off-chain signature verification.
	function setSigner(address signer) external onlyRoleAllowProxy(LibAccessibility.SIGNER_ADMIN_ROLE) {
		MAStorage.layout().signer = signer;
		emit SignerSet(signer);
	}

	function checkZeroAddress(address target) private pure {
		require(target != address(0), "ControlFacet: Zero address");
	}

	/// @notice Sets the address that receives penalties from soft liquidations.
	/// @param softLiquidationPenaltyCollector The address that will receive soft liquidation penalty funds.
	function setSoftLiquidationPenaltyCollector(address softLiquidationPenaltyCollector) external onlyRole(LibAccessibility.FEE_ADMIN_ROLE) {
		MAStorage.layout().softLiquidationPenaltyCollector = softLiquidationPenaltyCollector;
		emit SetSoftLiquidationPenaltyCollector(softLiquidationPenaltyCollector);
	}

	/// @notice Controls whether a Party B can be bound to Party A accounts for exclusive trading relationships.
	/// @param partyB The address of the Party B to configure bindability for.
	/// @param bindable True to allow Party As to bind exclusively to this Party B, false to disable binding.
	function setPartyBBindable(address partyB, bool bindable) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(MAStorage.layout().partyBStatus[partyB], "ControlFacet: Address is not PartyB");
		accountLayout.isPartyBBindable[partyB] = bindable;
		emit SetPartyBBindable(partyB, bindable);
	}

	/// @notice Enables or disables cross partyB mode for a specific Party B.
	/// @dev Cross partyB mode allows Party B to manage all partyA positions from a single aggregated balance.
	///      This should be called AFTER migrating locked values using MigrationFacet.migrateCrossLockedValues.
	/// @param partyB The address of the Party B to configure.
	/// @param enabled True to enable cross partyB mode, false to disable.
	function setCrossPartyB(address partyB, bool enabled) external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		require(GlobalAppStorage.layout().crossEnabled, "ControlFacet: Cross feature disabled");
		require(MAStorage.layout().partyBStatus[partyB], "ControlFacet: Address is not PartyB");
		AccountStorage.layout().isCrossPartyB[partyB] = enabled;
		emit SetCrossPartyB(partyB, enabled);
	}
}
