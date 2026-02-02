// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IAffiliateFacet } from "./IAffiliateFacet.sol";
import { AccountLayerAccessibility } from "../../utils/AccountLayerAccessibility.sol";
import { AccountLayerPausable } from "../../utils/AccountLayerPausable.sol";
import { AccountLayerReentrancyGuard } from "../../utils/AccountLayerReentrancyGuard.sol";
import { AccountHubStorage } from "../../storages/AccountHubStorage.sol";
import { AffiliateHubStorage, AffiliateData, AffiliateRegistration, AffiliateState, Stakeholder, PendingFeeUpdate } from "../../storages/AffiliateHubStorage.sol";
import { LibAccountLayerAccessibility } from "../../libraries/LibAccountLayerAccessibility.sol";
import { LibAccountLayerUtils } from "../../libraries/LibAccountLayerUtils.sol";
import { LibAccountLayerSafeERC20 } from "../../libraries/LibAccountLayerSafeERC20.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";

contract AffiliateFacet is IAffiliateFacet, AccountLayerAccessibility, AccountLayerPausable, AccountLayerReentrancyGuard {
	using EnumerableSet for EnumerableSet.AddressSet;

	bytes32 private constant ACCOUNT_MANAGER_CODE_HASH = keccak256("ACM_V1");
	uint256 private constant SHARE_PRECISION = 1e18;

	// ==================== Affiliate Registration ====================

	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external whenNotPaused returns (address affiliateAddress) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();

		affiliateAddress = _generateAccountManagerAddress(msg.sender, reg.name, ahLayout);

		if (afLayout.affiliates[affiliateAddress].state != AffiliateState.NONE) revert AlreadyRegistered();
		if (reg.admin == address(0)) revert ZeroAddress();

		LibAccountLayerUtils.validateName(reg.name);
		_validateFeeShares(reg.stakeholders, reg.symmioShare);

		AffiliateData storage affiliate = afLayout.affiliates[affiliateAddress];
		affiliate.name = reg.name;
		affiliate.brandColor = reg.brandColor;
		affiliate.admin = reg.admin;
		affiliate.state = AffiliateState.PENDING;
		affiliate.metadata = reg.metadata;
		affiliate.feeDetails.symmioShare = reg.symmioShare;
		affiliate.feeDetails.stakeholders = reg.stakeholders;
		affiliate.legacyMultiAccounts = reg.legacyMultiAccounts;
		affiliate.registrant = msg.sender;

		for (uint256 i = 0; i < reg.symmioCores.length; i++) {
			if (!afLayout.whitelistedSymmioCores[reg.symmioCores[i]]) revert NoWhitelistedSymmioCore();
			affiliate.symmioCores.add(reg.symmioCores[i]);
		}

		emit AffiliateRegistered(affiliateAddress, reg.name);
	}

	function cancelRegistration(address affiliate) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();

		_clearAffiliateData(afLayout, affiliate);
		emit RegistrationCancelled(affiliate);
	}

	function rejectRegistration(address affiliate) external onlyRole(LibAccountLayerAccessibility.APPROVER_ROLE) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();

		_clearAffiliateData(afLayout, affiliate);
		emit RegistrationRejected(affiliate, msg.sender);
	}

	function approveAffiliate(address affiliate) external onlyRole(LibAccountLayerAccessibility.APPROVER_ROLE) whenNotPaused {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();

		// Deploy AccountManager via ControlFacet's internal function
		address accountManager = _deployAccountManager(afLayout.affiliates[affiliate].registrant, afLayout.affiliates[affiliate].name);
		if (affiliate != accountManager) revert("AffiliateFacet: Deployment mismatch");

		// Grant SIGNER_SETTER_ROLE to the account manager
		LibAccountLayerAccessibility.grantRole(accountManager, LibAccountLayerAccessibility.SIGNER_SETTER_ROLE);

		address feeDistributor = _generateFeeDistributorAddress(affiliate, ++AccountHubStorage.layout().globalNonce);

		afLayout.affiliates[affiliate].state = AffiliateState.ACTIVE;
		afLayout.affiliates[affiliate].accountManager = accountManager;
		afLayout.affiliates[affiliate].feeDetails.feeDistributor = feeDistributor;

		_setupAffiliateOnSymmioCore(affiliate);

		address[] memory legacyAccounts = afLayout.affiliates[affiliate].legacyMultiAccounts;
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			afLayout.legacyMultiAccounts.add(legacyAccounts[i]);
		}

		emit AffiliateApproved(affiliate, feeDistributor);
	}

	// ==================== Affiliate Admin Management ====================

	function proposeAdminTransfer(address affiliate, address newAdmin) external whenNotPaused onlyIfAffiliateIsActive(affiliate) onlyAffiliateAdmin(affiliate) {
		if (newAdmin == address(0)) revert ZeroAddress();

		AffiliateHubStorage.layout().affiliates[affiliate].pendingAdmin = newAdmin;
		emit AdminTransferProposed(affiliate, newAdmin);
	}

	function acceptAdminTransfer(address affiliate) external whenNotPaused {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].pendingAdmin != msg.sender) revert Unauthorized();

		address oldAdmin = afLayout.affiliates[affiliate].admin;
		afLayout.affiliates[affiliate].admin = msg.sender;
		afLayout.affiliates[affiliate].pendingAdmin = address(0);

		emit AdminTransferCompleted(affiliate, oldAdmin, msg.sender);
	}

	function cancelAdminTransfer(address affiliate) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		AffiliateHubStorage.layout().affiliates[affiliate].pendingAdmin = address(0);
		emit AdminTransferCancelled(affiliate);
	}

	function updateAffiliateDetails(
		address affiliate,
		string memory name,
		string memory brandColor
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		LibAccountLayerUtils.validateName(name);

		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		afLayout.affiliates[affiliate].name = name;
		afLayout.affiliates[affiliate].brandColor = brandColor;

		emit AffiliateUpdated(affiliate, name, brandColor);
	}

	function pauseAffiliate(address affiliate) external whenNotPaused onlyIfAffiliateIsActive(affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (!LibAccountLayerAccessibility.hasRole(msg.sender, LibAccountLayerAccessibility.PAUSER_ROLE) && afLayout.affiliates[affiliate].admin != msg.sender) {
			revert Unauthorized();
		}

		afLayout.affiliates[affiliate].state = AffiliateState.PAUSED;
		emit AffiliatePaused(affiliate);
	}

	function unpauseAffiliate(address affiliate) external onlyRole(LibAccountLayerAccessibility.UNPAUSER_ROLE) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (afLayout.affiliates[affiliate].state != AffiliateState.PAUSED) revert InvalidState();

		afLayout.affiliates[affiliate].state = AffiliateState.ACTIVE;
		emit AffiliateUnpaused(affiliate);
	}

	// ==================== Fee Management ====================

	function requestFeeUpdate(
		address affiliate,
		Stakeholder[] memory newStakeholders,
		uint256 newSymmioShare
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		_validateFeeShares(newStakeholders, newSymmioShare);

		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		PendingFeeUpdate storage pending = afLayout.pendingFeeUpdates[affiliate];
		pending.symmioShare = newSymmioShare;
		pending.timestamp = block.timestamp;
		pending.exists = true;
		pending.stakeholders = newStakeholders;

		emit StakeholdersUpdateRequested(affiliate);
	}

	function cancelFeeUpdate(address affiliate) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (!afLayout.pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		delete afLayout.pendingFeeUpdates[affiliate];
		emit FeeUpdateCancelled(affiliate);
	}

	function approveFeeUpdate(address affiliate) external onlyRole(LibAccountLayerAccessibility.APPROVER_ROLE) whenNotPaused {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		if (!afLayout.pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		delete afLayout.affiliates[affiliate].feeDetails.stakeholders;
		afLayout.affiliates[affiliate].feeDetails.symmioShare = afLayout.pendingFeeUpdates[affiliate].symmioShare;
		afLayout.affiliates[affiliate].feeDetails.stakeholders = afLayout.pendingFeeUpdates[affiliate].stakeholders;

		delete afLayout.pendingFeeUpdates[affiliate];
		emit StakeholdersUpdated(affiliate);
	}

	function claimAllFees(address affiliate, address symmio) external whenNotPaused nonReentrant {
		_claimFees(affiliate, symmio, LibAccountLayerUtils.getClaimableFee(affiliate, symmio), msg.sender);
	}

	function claimFees(address affiliate, address symmio, uint256 amount) external whenNotPaused nonReentrant {
		_claimFees(affiliate, symmio, amount, msg.sender);
	}

	// ==================== Hook Management ====================

	function setHook(address affiliate, bytes4 selector, address hook) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		AffiliateHubStorage.layout().affiliates[affiliate].hooks[selector] = hook;
		emit HookSet(affiliate, selector, hook);
	}

	function removeHook(address affiliate, bytes4 selector) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		delete AffiliateHubStorage.layout().affiliates[affiliate].hooks[selector];
		emit HookRemoved(affiliate, selector);
	}

	// ==================== Operator Management ====================

	function setOperator(
		address affiliate,
		bytes4 selector,
		address operator,
		bool status
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		if (operator == address(0)) revert ZeroAddress();
		AffiliateHubStorage.layout().operators[affiliate][selector][operator] = status;
		emit OperatorSet(affiliate, selector, operator, status);
	}

	// ==================== Express Withdraw Configuration ====================

	function setExpressRate(address affiliate, uint256 expressRate) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		if (expressRate > SHARE_PRECISION) revert InvalidShare();
		AffiliateHubStorage.layout().affiliates[affiliate].expressRate = expressRate;
		emit ExpressRateSet(affiliate, expressRate);
	}

	function setVirtualProvider(address affiliate, address virtualProvider) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		AffiliateHubStorage.layout().affiliates[affiliate].virtualProvider = virtualProvider;
		emit VirtualProviderSet(affiliate, virtualProvider);
	}

	// ==================== Delegated Calls ====================

	function callAsAffiliate(
		address affiliate,
		address symmio,
		bytes calldata callData
	) external whenNotPaused nonReentrant onlyIfAffiliateIsActive(affiliate) returns (bytes memory result) {
		if (callData.length < 4) revert InvalidCallData();

		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		bytes4 selector = bytes4(callData[:4]);
		if (!afLayout.callAllowedSelectors[affiliate][selector]) revert SelectorNotAllowed(selector);
		if (afLayout.affiliates[affiliate].admin != msg.sender && !afLayout.operators[affiliate][selector][msg.sender]) revert Unauthorized();
		if (!afLayout.affiliates[affiliate].symmioCores.contains(symmio)) revert SymmioCoreNotAllowed();

		ISymmio(symmio).setSigner(affiliate);
		(bool success, bytes memory returned) = symmio.call(callData);
		ISymmio(symmio).setSigner(address(0));

		if (!success) {
			assembly {
				revert(add(returned, 32), mload(returned))
			}
		}

		return returned;
	}

	// ==================== Internal Functions ====================

	/// @dev Properly clears AffiliateData including nested EnumerableSet before deletion.
	///      Mappings inside structs are not cleared by `delete`, so we must explicitly
	///      remove all elements from the EnumerableSet to prevent stale data.
	function _clearAffiliateData(AffiliateHubStorage.Layout storage afLayout, address affiliate) private {
		AffiliateData storage data = afLayout.affiliates[affiliate];

		// Clear the EnumerableSet (contains internal mappings that `delete` won't clear)
		uint256 length = data.symmioCores.length();
		for (uint256 i = length; i > 0; i--) {
			data.symmioCores.remove(data.symmioCores.at(i - 1));
		}

		// Clear the stakeholders array
		delete data.feeDetails.stakeholders;

		// Now delete the struct (clears all non-mapping fields)
		delete afLayout.affiliates[affiliate];
	}

	function _validateFeeShares(Stakeholder[] memory stakeholders, uint256 symmioShare) private pure {
		if (symmioShare > SHARE_PRECISION) revert InvalidShare();

		uint256 totalShare = symmioShare;
		for (uint256 i = 0; i < stakeholders.length; i++) {
			if (stakeholders[i].receiver == address(0)) revert ZeroAddress();
			totalShare += stakeholders[i].share;
		}

		if (totalShare != SHARE_PRECISION) revert SharesMustSumTo100();
	}

	function _setupAffiliateOnSymmioCore(address affiliate) private {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		EnumerableSet.AddressSet storage cores = afLayout.affiliates[affiliate].symmioCores;
		address feeDistributor = afLayout.affiliates[affiliate].feeDetails.feeDistributor;

		for (uint256 i = 0; i < cores.length(); i++) {
			ISymmio(cores.at(i)).registerAffiliate(affiliate);
			ISymmio(cores.at(i)).setFeeCollector(affiliate, feeDistributor);
		}
	}

	function _claimFees(address affiliate, address symmio, uint256 amount, address caller) private {
		AffiliateHubStorage.Layout storage afLayout = AffiliateHubStorage.layout();
		address collateral = ISymmio(symmio).getCollateral();
		Stakeholder[] memory stakeholders = afLayout.affiliates[affiliate].feeDetails.stakeholders;

		bool auth = false;
		for (uint256 i = 0; i < stakeholders.length; i++) {
			if (caller == stakeholders[i].receiver) {
				auth = true;
				break;
			}
		}

		if (!auth && !LibAccountLayerAccessibility.hasRole(caller, LibAccountLayerAccessibility.DISTRIBUTOR_ROLE)) revert Unauthorized();

		ISymmio(symmio).setSigner(afLayout.affiliates[affiliate].feeDetails.feeDistributor);
		ISymmio(symmio).withdrawTo(address(this), amount);
		ISymmio(symmio).setSigner(address(0));

		for (uint256 i = 0; i < stakeholders.length; i++) {
			uint256 share = (stakeholders[i].share * amount) / SHARE_PRECISION;
			LibAccountLayerSafeERC20.safeTransfer(collateral, stakeholders[i].receiver, share);
			emit FeesDistributed(stakeholders[i].receiver, share);
		}

		uint256 symmioAmount = (afLayout.affiliates[affiliate].feeDetails.symmioShare * amount) / SHARE_PRECISION;
		if (symmioAmount > 0) {
			LibAccountLayerSafeERC20.safeTransfer(collateral, afLayout.symmioFeeReceiver, symmioAmount);
			emit FeesDistributed(afLayout.symmioFeeReceiver, symmioAmount);
		}

		emit FeesClaimed(affiliate, symmio, amount);
	}

	function _generateFeeDistributorAddress(address affiliate, uint256 nonce) private pure returns (address) {
		bytes32 VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH = keccak256("VFD_V1");
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(nonce)), VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH))
					)
				)
			);
	}

	function _generateAccountManagerAddress(address registrant, string memory name, AccountHubStorage.Layout storage ahLayout) private view returns (address) {
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, registrant, name));
		bytes memory bytecode = abi.encodePacked(ahLayout.accountManagerImplementation, abi.encode(address(this)));
		bytes32 initCodeHash = keccak256(bytecode);
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
	}

	function _deployAccountManager(address user, string memory name) private returns (address accountManager) {
		AccountHubStorage.Layout storage ahLayout = AccountHubStorage.layout();
		bytes32 salt = keccak256(abi.encodePacked(ACCOUNT_MANAGER_CODE_HASH, user, name));
		bytes memory bytecode = abi.encodePacked(ahLayout.accountManagerImplementation, abi.encode(address(this)));

		assembly {
			accountManager := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
		}

		if (accountManager == address(0)) revert("AffiliateFacet: Deployment failed");
	}
}
