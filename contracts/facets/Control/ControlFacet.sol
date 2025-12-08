// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../utils/Ownable.sol";
import "../../utils/Accessibility.sol";
import "../../storages/MAStorage.sol";
import "../../storages/MuonStorage.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../storages/SymbolStorage.sol";
import "./IControlFacet.sol";
import "../../libraries/LibDiamond.sol";
import "../../storages/BridgeStorage.sol";
import "../../storages/WithdrawStorage.sol";

contract ControlFacet is Accessibility, Ownable, IControlFacet {
	/// @notice Transfers ownership of the contract to a new address.
	function transferOwnership(address owner) external onlyOwner {
		checkZeroAddress(owner);
		LibDiamond.transferOwnership(owner);
	}

	/// @notice Cancels the pending ownership transfer.
	function cancelOwnershipTransfer() external onlyOwner {
		LibDiamond.cancelOwnershipTransfer();
	}

	/// @notice Accept ownership of the contract.
	function acceptOwnership() external {
		LibDiamond.acceptOwnership();
	}

	/// @notice Grants admin role to a specified user.
	function setAdmin(address user) external onlyOwner {
		checkZeroAddress(user);
		GlobalAppStorage.layout().hasRole[user][LibAccessibility.DEFAULT_ADMIN_ROLE] = true;
		emit RoleGranted(LibAccessibility.DEFAULT_ADMIN_ROLE, user);
	}

	/// @notice Grants a specified role to a user.
	function grantRole(address user, bytes32 role) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
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

	/// @notice Revokes a specified role from a user.
	function revokeRole(address user, bytes32 role) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		GlobalAppStorage.layout().hasRole[user][role] = false;
		emit RoleRevoked(role, user);
	}

	/// @notice Registers a Party B into the system.
	function registerPartyB(address partyB) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		checkZeroAddress(partyB);
		require(!MAStorage.layout().partyBStatus[partyB], "ControlFacet: Address is already registered");
		MAStorage.layout().partyBStatus[partyB] = true;
		MAStorage.layout().partyBList.push(partyB);
		emit RegisterPartyB(partyB);
	}

	/// @notice Deregisters a Party B from the system.
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

	/// @notice Registers an affiliate into the system.
	function registerAffiliate(address affiliate) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		require(!MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Address is already registered");
		MAStorage.layout().affiliateStatus[affiliate] = true;
		emit RegisterAffiliate(affiliate);
	}

	/// @notice Deregisters an affiliate from the system.
	function deregisterAffiliate(address affiliate) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Address is not registered");
		MAStorage.layout().affiliateStatus[affiliate] = false;
		emit DeregisterAffiliate(affiliate);
	}

	/// @notice Sets the configuration parameters for Muon.
	function setMuonConfig(uint256 upnlValidTime, uint256 priceValidTime) external onlyRole(LibAccessibility.MUON_SETTER_ROLE) {
		emit SetMuonConfig(upnlValidTime, priceValidTime);
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		muonLayout.upnlValidTime = upnlValidTime;
		muonLayout.priceValidTime = priceValidTime;
	}

	/// @notice Sets the Muon application ID.
	function setMuonIds(uint256 muonAppId) external onlyRole(LibAccessibility.MUON_SETTER_ROLE) {
		MuonStorage.Layout storage muonLayout = MuonStorage.layout();
		muonLayout.muonAppId = muonAppId;
		emit SetMuonIds(muonAppId);
	}

	/// @notice Sets the address of the collateral token.
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

	/// @notice Sets number of allowed pending quotes per user.
	function setPendingQuotesValidLength(uint256 pendingQuotesValidLength) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetPendingQuotesValidLength(MAStorage.layout().pendingQuotesValidLength, pendingQuotesValidLength);
		MAStorage.layout().pendingQuotesValidLength = pendingQuotesValidLength;
	}

	/// @notice Sets the address which protocol fees for an specific affiliate are being transferred to.
	function setFeeCollector(address affiliate, address feeCollector) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		checkZeroAddress(feeCollector);
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Invalid affiliate");
		emit SetFeeCollector(affiliate, GlobalAppStorage.layout().affiliateFeeCollector[affiliate], feeCollector);
		GlobalAppStorage.layout().affiliateFeeCollector[affiliate] = feeCollector;
	}

	/// @notice Sets the open and close trading fees for an specific affiliate.
	function setAffiliateFee(address affiliate, uint256 symbolId, uint256 openFee, uint256 closeFee) external {
		require(
			LibAccessibility.hasRole(msg.sender, LibAccessibility.AFFILIATE_MANAGER_ROLE) || msg.sender == affiliate,
			"ControlFacet: Not authorized"
		);
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Invalid affiliate");
		require(openFee <= 1e18 && closeFee <= 1e18, "ControlFacet: High fee");
		require(openFee >= appLayout.minAffiliateFee && closeFee >= appLayout.minAffiliateFee, "ControlFacet: Not allowed to set fee less than threshold");
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

	/// @notice Sets the open and close trading fees for an specific affiliate and specific user in the system.
	/// @param affiliate The address of affiliate.
	/// @param user The address of user.
	/// @param symbolId The id of symbol.
	/// @param openFee The open trading fee.
	/// @param closeFee The open trading fee.
	function setCustomAffiliateFee(address affiliate,address user, uint256 symbolId, uint256 openFee, uint256 closeFee) external {
		require(
			LibAccessibility.hasRole(msg.sender, LibAccessibility.AFFILIATE_MANAGER_ROLE) || msg.sender == affiliate,
			"ControlFacet: Not authorized"
		);
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		require(MAStorage.layout().affiliateStatus[affiliate], "ControlFacet: Invalid affiliate");
		require(openFee <= 1e18 && closeFee <= 1e18, "ControlFacet: High fee");
		require(openFee >= appLayout.minAffiliateFee && closeFee >= appLayout.minAffiliateFee, "ControlFacet: Not allowed to set fee less than threshold");
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

	/// @notice Sets the default open and close trading fees for an specific affiliate in the system.
	/// @param affiliate The address of affiliate.
	/// @param openFee The open trading fee.
	/// @param closeFee The close trading fee.
	function setDefaultAffiliateFee(address affiliate, uint256 openFee, uint256 closeFee) external onlyRole(LibAccessibility.SETTER_ROLE) {
		require(openFee <= 1e18 && closeFee <= 1e18, "ControlFacet: High fee");
		emit SetDefaultAffiliateFee(
			affiliate,
			GlobalAppStorage.layout().defaultAffiliateFee[affiliate].openFee,
			openFee,
			GlobalAppStorage.layout().defaultAffiliateFee[affiliate].closeFee,
			closeFee
		);
		GlobalAppStorage.layout().defaultAffiliateFee[affiliate] = Fee(openFee, closeFee, true);
	}

	/// @notice Sets the address of the default fee collector.
	function setDefaultFeeCollector(address feeCollector) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetDefaultFeeCollector(GlobalAppStorage.layout().defaultFeeCollector, feeCollector);
		GlobalAppStorage.layout().defaultFeeCollector = feeCollector;
	}

	/// @notice Sets the minimum affiliate fee.
	/// @param minAffiliateFee The minimum affiliate fee.
	function setMinAffiliateFee(uint256 minAffiliateFee) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetMinAffiliateFee(GlobalAppStorage.layout().minAffiliateFee, minAffiliateFee);
		GlobalAppStorage.layout().minAffiliateFee = minAffiliateFee;
	}

	/// @notice Sets the deallocate debounce time. User can't deallocate more than once in this window
	/// @param deallocateDebounceTime in seconds.
	function setDeallocateDebounceTime(uint256 deallocateDebounceTime) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetDeallocateDebounceTime(MAStorage.layout().deallocateDebounceTime, deallocateDebounceTime);
		MAStorage.layout().deallocateDebounceTime = deallocateDebounceTime;
	}

	/// @notice Sets invalid bridged amounts pool address.
	function setInvalidBridgedAmountsPool(address pool) external onlyRole(LibAccessibility.SETTER_ROLE) {
		checkZeroAddress(pool);
		emit SetInvalidBridgedAmountsPool(BridgeStorage.layout().invalidBridgedAmountsPool, pool);
		BridgeStorage.layout().invalidBridgedAmountsPool = pool;
	}

	/// @notice Sets the metadata for an affiliate.
	function setAffiliateMetadata(address affiliate, EntityMetadata memory metadata) external onlyRole(LibAccessibility.AFFILIATE_MANAGER_ROLE) {
		MAStorage.layout().entitiesMetadata[affiliate] = metadata;
		emit SetEntityMetadata(affiliate, metadata);
	}

	/// @notice Sets the metadata for a party B.
	function setPartyBMetadata(address partyB, EntityMetadata memory metadata) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		MAStorage.layout().entitiesMetadata[partyB] = metadata;
		emit SetEntityMetadata(partyB, metadata);
	}

	// CoolDowns //////////////////////////////////////////////////

	/// @notice Sets the cooldown period for deallocation.
	function setDeallocateCooldown(uint256 deallocateCooldown) external onlyRole(LibAccessibility.DEALLOCATE_COOLDOWN_SETTER_ROLE) {
		emit SetDeallocateCooldown(MAStorage.layout().deallocateCooldown, deallocateCooldown);
		MAStorage.layout().deallocateCooldown = deallocateCooldown;
	}

	/// @notice Sets the cooldown period for force cancellation.
	function setForceCancelCooldown(uint256 forceCancelCooldown) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetForceCancelCooldown(MAStorage.layout().forceCancelCooldown, forceCancelCooldown);
		MAStorage.layout().forceCancelCooldown = forceCancelCooldown;
	}

	/// @notice Sets the cooldown periods for force closing positions.
	function setForceCloseCooldowns(
		uint256 forceCloseFirstCooldown,
		uint256 forceCloseSecondCooldown
	) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetForceCloseCooldowns(
			MAStorage.layout().forceCloseFirstCooldown,
			forceCloseFirstCooldown,
			MAStorage.layout().forceCloseSecondCooldown,
			forceCloseSecondCooldown
		);
		MAStorage.layout().forceCloseFirstCooldown = forceCloseFirstCooldown;
		MAStorage.layout().forceCloseSecondCooldown = forceCloseSecondCooldown;
	}

	/// @notice Sets the penalty applied to partyB during force closing.
	function setForceClosePricePenalty(uint256 forceClosePricePenalty) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetForceClosePricePenalty(MAStorage.layout().forceClosePricePenalty, forceClosePricePenalty);
		MAStorage.layout().forceClosePricePenalty = forceClosePricePenalty;
	}

	/// @notice Sets the minimum signature period for force closing.
	function setForceCloseMinSigPeriod(uint256 forceCloseMinSigPeriod) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetForceCloseMinSigPeriod(MAStorage.layout().forceCloseMinSigPeriod, forceCloseMinSigPeriod);
		MAStorage.layout().forceCloseMinSigPeriod = forceCloseMinSigPeriod;
	}

	/// @notice Sets the cooldown period for force canceling close requests.
	function setForceCancelCloseCooldown(uint256 forceCancelCloseCooldown) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetForceCancelCloseCooldown(MAStorage.layout().forceCancelCloseCooldown, forceCancelCloseCooldown);
		MAStorage.layout().forceCancelCloseCooldown = forceCancelCloseCooldown;
	}

	/// @notice Sets the percentage of funds distributed to liquidators.
	function setLiquidatorShare(uint256 liquidatorShare) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetLiquidatorShare(MAStorage.layout().liquidatorShare, liquidatorShare);
		MAStorage.layout().liquidatorShare = liquidatorShare;
	}

	/// @notice Sets the gap ratio used in force closing.
	function setForceCloseGapRatio(uint256 symbolId, uint256 forceCloseGapRatio) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetForceCloseGapRatio(symbolId, SymbolStorage.layout().forceCloseGapRatio[symbolId], forceCloseGapRatio);
		SymbolStorage.layout().forceCloseGapRatio[symbolId] = forceCloseGapRatio;
	}

	/// @notice Sets the cooldown period for settle upnl.
	function setSettlementCooldown(uint256 settlementCooldown) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetSettlementCooldown(MAStorage.layout().settlementCooldown, settlementCooldown);
		MAStorage.layout().settlementCooldown = settlementCooldown;
	}

	/// @notice Sets the cooldown period for unbinding.
	function setUnbindCooldown(uint256 unbindCooldown) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetUnbindCooldown(MAStorage.layout().unbindCooldown, unbindCooldown);
		MAStorage.layout().unbindCooldown = unbindCooldown;
	}

	/// @notice Sets PartyA Max Connection with PartyB.
	function setMaxPartyAConnectionLimit(uint256 maxLimit) external onlyRole(LibAccessibility.SETTER_ROLE) {
		require(maxLimit > 0, "ControlFacet: Value must be greater than zero");
		MAStorage.layout().maxPartyAConnectionLimit = maxLimit;
		emit SetMaxPartyAConnectionLimit(maxLimit);
	}

	/// @notice Sets the timeout duration for liquidation.
	function setLiquidationTimeout(uint256 liquidationTimeout) external onlyRole(LibAccessibility.SETTER_ROLE) {
		emit SetLiquidationTimeout(MAStorage.layout().liquidationTimeout, liquidationTimeout);
		MAStorage.layout().liquidationTimeout = liquidationTimeout;
	}

	/// @notice Sets the balance limit per user.
	function setBalanceLimitPerUser(uint256 balanceLimitPerUser) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		emit SetBalanceLimitPerUser(balanceLimitPerUser);
		GlobalAppStorage.layout().balanceLimitPerUser = balanceLimitPerUser;
	}

	/// @notice Enables or disables master account activation for Party B.
	function setMasterAccountActivationMode(bool enabled) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		emit SetMasterAccountActivationMode(appLayout.masterAccountActivationMode, enabled);
		appLayout.masterAccountActivationMode = enabled;
	}

	/// @notice Adds a bridge.
	function addBridge(address bridge) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		checkZeroAddress(bridge);
		BridgeStorage.layout().bridges[bridge] = true;
		emit AddBridge(bridge);
	}

	/// @notice Removes a bridge.
	function removeBridge(address bridge) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		BridgeStorage.layout().bridges[bridge] = false;
		emit RemoveBridge(bridge);
	}

	/// @notice Sets the params for liquidation insurance vault.
	function setLiquidationInsuranceVaultParams(
		address insuranceVault,
		uint256 maxLiquidationProfit
	) external onlyRole(LibAccessibility.SETTER_ROLE) {
		checkZeroAddress(insuranceVault);
		MAStorage.Layout storage maLayout = MAStorage.layout();
		maLayout.liquidationInsuranceVault = insuranceVault;
		maLayout.maxLiquidationProfitPerPosition = maxLiquidationProfit;
		emit SetLiquidationInsuranceVaultParams(insuranceVault, maxLiquidationProfit);
	}

	/// @notice Sets the signature verifier address.
	function setSignatureVerifierAddress(address signatureVerifier) external onlyRole(LibAccessibility.SETTER_ROLE) {
		GlobalAppStorage.layout().signatureVerifier = signatureVerifier;
		emit SetSignatureVerifierAddress(signatureVerifier);
	}

	/// @notice Adds a relayer for an external transfer target.
	function addRelayerForExternalTransferTarget(address target, address relayer) external onlyRole(LibAccessibility.SETTER_ROLE) {
		checkZeroAddress(target);
		AccountStorage.layout().externalTransferTargetsRelayers[target] = relayer;
		emit AddRelayerForExternalTransferTarget(target, relayer);
	}

	/// @notice Removes a relayer for an external transfer target.
	function removeRelayerForExternalTransferTarget(address target) external onlyRole(LibAccessibility.SETTER_ROLE) {
		checkZeroAddress(target);
		AccountStorage.layout().externalTransferTargetsRelayers[target] = address(0);
		emit RemoveRelayerForExternalTransferTarget(target);
	}

	/// @notice Registers a hook for an affiliate.
	function registerHook(address affiliate, address hook) external onlyRole(LibAccessibility.SETTER_ROLE) {
		AccountStorage.layout().affiliateHooks[affiliate] = hook;
		emit RegisterHook(affiliate, hook);
	}

	/// @notice Sets the call from instant layer.
	function setCallFromInstantLayer(bool _callFromInstantLayer) external onlyRole(LibAccessibility.INSTANT_LAYER_ROLE) {
		require(!(_callFromInstantLayer && GlobalAppStorage.layout().instantLayerPaused), "ControlFacet: Instant Layer Paused");
		MAStorage.layout().callFromInstantLayer = _callFromInstantLayer;
	}

	/// @notice Sets the ADL enabled status for a party B.
	function setADLEnabled(address partyB, bool enabled) external onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		MAStorage.layout().adlEnabled[partyB] = enabled;
		emit SetADLEnabled(partyB, enabled);
	}

	function setMaxDeallocateWithdrawCooldownPeriod(uint256 _withdrawCooldownPeriod) external onlyRole(LibAccessibility.SETTER_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.withdrawCooldownPeriod = _withdrawCooldownPeriod;
		emit SetWithdrawCooldownPeriod(_withdrawCooldownPeriod);
		emit SetDeallocateCooldown(MAStorage.layout().deallocateCooldown, _withdrawCooldownPeriod);
		MAStorage.layout().deallocateCooldown = _withdrawCooldownPeriod;
	}

	function setMaxWithdrawParts(uint256 _maxWithdrawParts) external onlyRole(LibAccessibility.SETTER_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.maxWithdrawParts = _maxWithdrawParts;
		emit SetMaxWithdrawParts(_maxWithdrawParts);
	}

	function setWithdrawCooldownPeriod(uint256 _withdrawCooldownPeriod) external onlyRole(LibAccessibility.SETTER_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		withdrawLayout.withdrawCooldownPeriod = _withdrawCooldownPeriod;
		emit SetWithdrawCooldownPeriod(_withdrawCooldownPeriod);
	}

	function registerVirtualProvider(address provider) external onlyRole(LibAccessibility.SETTER_ROLE) {
		require(!GlobalAppStorage.layout().expressProviders[provider], "ControlFacet: Already a express provider");
		require(!GlobalAppStorage.layout().virtualProviders[provider], "ControlFacet: Already a virtual provider");
		GlobalAppStorage.layout().virtualProviders[provider] = true;
		emit RegisterVirtualProvider(provider);
	}

	function unregisterVirtualProvider(address provider) external onlyRole(LibAccessibility.SETTER_ROLE) {
		GlobalAppStorage.layout().virtualProviders[provider] = false;
		emit UnregisterVirtualProvider(provider);
	}

	function registerExpressProvider(address provider) external onlyRole(LibAccessibility.SETTER_ROLE) {
		require(!GlobalAppStorage.layout().virtualProviders[provider], "ControlFacet: Already a virtual provider");
		require(!GlobalAppStorage.layout().expressProviders[provider], "ControlFacet: Already a express provider");
		GlobalAppStorage.layout().expressProviders[provider] = true;
		emit RegisterExpressProvider(provider);
	}

	function unregisterExpressProvider(address provider) external onlyRole(LibAccessibility.SETTER_ROLE) {
		GlobalAppStorage.layout().expressProviders[provider] = false;
		emit UnregisterExpressProvider(provider);
	}

	function setSpeedUpUser(address user) external onlyRole(LibAccessibility.WITHDRAW_SPEED_UP_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		require(!withdrawLayout.speedUpWhitelist[user], "ControlFacet: User already whitelisted as speed up");
		withdrawLayout.speedUpWhitelist[user] = true;
		emit SetSpeedUpUser(user);
	}

	function unsetSpeedUpUser(address user) external onlyRole(LibAccessibility.WITHDRAW_SPEED_UP_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		require(withdrawLayout.speedUpWhitelist[user], "ControlFacet: User not whitelisted as speed up");
		withdrawLayout.speedUpWhitelist[user] = false;
		emit UnsetSpeedUpUser(user);
	}

	function setMinWithdrawCooldown(uint256 cooldown) external onlyRole(LibAccessibility.SETTER_ROLE) {
		WithdrawStorage.Layout storage withdrawLayout = WithdrawStorage.layout();
		emit SetMinWithdrawCooldown(withdrawLayout.minWithdrawCooldown, cooldown);
		withdrawLayout.minWithdrawCooldown = cooldown;
	}

	function setSigner(address signer) external onlyRole(LibAccessibility.SIGNER_SETTER_ROLE) {
		MAStorage.layout().signer = signer;
		emit SignerSet(signer);
	}

	function checkZeroAddress(address target) private pure {
		require(target != address(0), "ControlFacet: Zero address");
	}
}
