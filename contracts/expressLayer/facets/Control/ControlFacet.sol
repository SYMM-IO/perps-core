// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { AffiliateConfig, SponsorConfig } from "../../types/ConfigTypes.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";

import { ExpressProviderStorage } from "../../storages/ExpressProviderStorage.sol";

import { IControlFacet } from "./IControlFacet.sol";

contract ControlFacet is IControlFacet {
	using SafeERC20 for IERC20;

	// ── Config setters ──

	function setCreditLineManager(address affiliate, address manager) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ExpressProviderStorage.layout().creditLineManagers[affiliate] = manager;
	}

	function setSecurityWindow(uint256 _securityWindow) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		if (_securityWindow < 10) revert LibErrors.SecurityWindowTooLow();
		ExpressProviderStorage.layout().securityWindow = _securityWindow;
	}

	function setTolerancePeriod(uint256 _tolerancePeriod) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		if (_tolerancePeriod < 10) revert LibErrors.TolerancePeriodTooLow();
		ExpressProviderStorage.layout().tolerancePeriod = _tolerancePeriod;
	}

	/// @notice Sets the minimum validator signatures for an affiliate (address(0) = default for all).
	function setMinValidatorSignatures(address affiliate, uint256 _minValidatorSignatures) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ExpressProviderStorage.layout().minValidatorSignatures[affiliate] = _minValidatorSignatures;
		emit MinValidatorSignaturesUpdated(affiliate, _minValidatorSignatures);
	}

	/// @notice Sets the validator approval timeout for an affiliate (address(0) = default for all).
	function setValidatorApprovalTimeout(address affiliate, uint256 _timeout) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ExpressProviderStorage.layout().validatorApprovalTimeout[affiliate] = _timeout;
		emit ValidatorApprovalTimeoutUpdated(affiliate, _timeout);
	}

	/// @notice Registers or removes a validator for an affiliate (address(0) = default for all).
	function setValidator(address affiliate, address validator, bool enabled) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ExpressProviderStorage.layout().validators[affiliate][validator] = enabled;
		emit ValidatorUpdated(affiliate, validator, enabled);
	}

	function setAffiliateConfig(address affiliate, uint256 feeRate, uint256 _operatorFee) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		if (feeRate > 10000) revert LibErrors.FeeRateExceeds100Percent();
		ExpressProviderStorage.layout().affiliateConfigs[affiliate] = AffiliateConfig(feeRate, _operatorFee);
		emit AffiliateConfigUpdated(affiliate, feeRate, _operatorFee);
	}

	// ── Fee claims ──

	function claimFees(address affiliate, address to) external {
		LibAccessControl.enforceRole(LibAccessControl.FEE_CLAIMER_ROLE);
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		uint256 amount = s.collectedFees[affiliate];
		if (amount == 0) revert LibErrors.NoFeesToClaim();
		s.collectedFees[affiliate] = 0;
		s.collateral.safeTransfer(to, amount);
		emit FeesClaimed(affiliate, amount);
	}

	function claimOperatorFees(address affiliate, address to) external {
		LibAccessControl.enforceRole(LibAccessControl.FEE_CLAIMER_ROLE);
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		uint256 amount = s.collectedOperatorFees[affiliate];
		if (amount == 0) revert LibErrors.NoOperatorFeesToClaim();
		s.collectedOperatorFees[affiliate] = 0;
		s.collateral.safeTransfer(to, amount);
		emit OperatorFeesClaimed(affiliate, amount);
	}

	// ── Sponsor management ──

	function depositSponsorBalance(address affiliate, uint256 amount) external {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		s.collateral.safeTransferFrom(msg.sender, address(this), amount);
		s.sponsorBalances[affiliate] += amount;
		if (s.sponsors[affiliate] == address(0)) {
			s.sponsors[affiliate] = msg.sender;
		}
		emit SponsorDeposit(affiliate, amount);
	}

	function withdrawSponsorBalance(address affiliate, uint256 amount, address to) external {
		LibAccessControl.enforceRole(LibAccessControl.SPONSOR_MANAGER_ROLE);
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (s.sponsorBalances[affiliate] < amount) revert LibErrors.InsufficientSponsorBalance();
		s.sponsorBalances[affiliate] -= amount;
		s.collateral.safeTransfer(to, amount);
		emit SponsorWithdraw(affiliate, amount);
	}

	function setSponsorConfig(address affiliate, uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ExpressProviderStorage.layout().sponsorConfigs[affiliate] = SponsorConfig(maxFeePerWithdraw, maxWithdrawAmount);
		emit SponsorConfigUpdated(affiliate, maxFeePerWithdraw, maxWithdrawAmount);
	}

	// ── General pool ──

	function depositToGeneral(uint256 amount) external {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		s.collateral.safeTransferFrom(msg.sender, address(this), amount);
		s.generalBalance += amount;
		emit GeneralDeposit(amount);
	}

	function withdrawFromGeneral(uint256 amount) external {
		LibAccessControl.enforceRole(LibAccessControl.WITHDRAWER_ROLE);
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		uint256 available = s.generalBalance > s.lockedGeneralBalance ? s.generalBalance - s.lockedGeneralBalance : 0;
		if (available < amount) revert LibErrors.InsufficientUnlockedGeneralBalance();
		s.generalBalance -= amount;
		s.collateral.safeTransfer(msg.sender, amount);
		emit GeneralWithdraw(amount);
	}

	// ── Affiliate pool ──

	function depositToAffiliate(address affiliate, uint256 amount) external {
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		s.collateral.safeTransferFrom(msg.sender, address(this), amount);
		s.affiliateBalances[affiliate] += amount;
		emit AffiliateDeposit(affiliate, amount);
	}

	function withdrawFromAffiliate(address affiliate, uint256 amount) external {
		LibAccessControl.enforceRole(LibAccessControl.WITHDRAWER_ROLE);
		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		if (s.affiliateBalances[affiliate] - s.lockedAffiliateBalances[affiliate] < amount) revert LibErrors.InsufficientUnlockedAffiliateBalance();
		s.affiliateBalances[affiliate] -= amount;
		s.collateral.safeTransfer(msg.sender, amount);
		emit AffiliateWithdraw(affiliate, amount);
	}

	// ── Role management (owner only) ──

	function grantRole(bytes32 role, address account) external {
		LibDiamond.enforceIsContractOwner();
		LibAccessControl.grantRole(account, role);
	}

	function revokeRole(bytes32 role, address account) external {
		LibDiamond.enforceIsContractOwner();
		LibAccessControl.revokeRole(account, role);
	}

	// ── Ownership ──

	function owner() external view returns (address) {
		return LibDiamond.contractOwner();
	}

	function pendingOwner() external view returns (address) {
		return LibDiamond.diamondStorage().pendingOwner;
	}

	function transferOwnership(address _newOwner) external {
		LibDiamond.enforceIsContractOwner();
		LibDiamond.transferOwnership(_newOwner);
	}

	function acceptOwnership() external {
		LibDiamond.acceptOwnership();
	}

	function cancelOwnershipTransfer() external {
		LibDiamond.enforceIsContractOwner();
		LibDiamond.cancelOwnershipTransfer();
	}
}
