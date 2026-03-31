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

import { GlobalStorage } from "../../storages/GlobalStorage.sol";
import { PoolStorage } from "../../storages/PoolStorage.sol";
import { FeeStorage } from "../../storages/FeeStorage.sol";
import { ValidatorStorage } from "../../storages/ValidatorStorage.sol";

import { IControlFacet } from "./IControlFacet.sol";

contract ControlFacet is IControlFacet {
	using SafeERC20 for IERC20;

	// ── Config setters ──

	function setSecurityWindow(uint256 _securityWindow) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		if (_securityWindow < 10) revert LibErrors.SecurityWindowTooLow();
		GlobalStorage.layout().securityWindow = _securityWindow;
	}

	function setTolerancePeriod(uint256 _tolerancePeriod) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		if (_tolerancePeriod < 10) revert LibErrors.TolerancePeriodTooLow();
		GlobalStorage.layout().tolerancePeriod = _tolerancePeriod;
	}

	/// @notice Sets the minimum validator signatures for an affiliate (address(0) = default for all).
	function setMinValidatorSignatures(address affiliate, uint256 _minValidatorSignatures) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ValidatorStorage.layout().minValidatorSignatures[affiliate] = _minValidatorSignatures;
		emit MinValidatorSignaturesUpdated(affiliate, _minValidatorSignatures);
	}

	/// @notice Sets the validator approval timeout for an affiliate (address(0) = default for all).
	function setValidatorApprovalTimeout(address affiliate, uint256 _timeout) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ValidatorStorage.layout().validatorApprovalTimeout[affiliate] = _timeout;
		emit ValidatorApprovalTimeoutUpdated(affiliate, _timeout);
	}

	/// @notice Registers or removes a validator for an affiliate (address(0) = default for all).
	function setValidator(address affiliate, address validator, bool enabled) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		ValidatorStorage.layout().validators[affiliate][validator] = enabled;
		emit ValidatorUpdated(affiliate, validator, enabled);
	}

	function setAffiliateConfig(address affiliate, uint256 feeRate, uint256 _operatorFee) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		if (feeRate > 10000) revert LibErrors.FeeRateExceeds100Percent();
		FeeStorage.layout().affiliateConfigs[affiliate] = AffiliateConfig(feeRate, _operatorFee);
		emit AffiliateConfigUpdated(affiliate, feeRate, _operatorFee);
	}

	// ── Fee claims ──

	function claimFees(address affiliate, address to) external {
		LibAccessControl.enforceRole(LibAccessControl.FEE_CLAIMER_ROLE);
		FeeStorage.Layout storage f = FeeStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		uint256 amount = f.collectedFees[affiliate];
		if (amount == 0) revert LibErrors.NoFeesToClaim();
		f.collectedFees[affiliate] = 0;
		g.collateral.safeTransfer(to, amount);
		emit FeesClaimed(affiliate, amount);
	}

	function claimOperatorFees(address affiliate, address to) external {
		LibAccessControl.enforceRole(LibAccessControl.FEE_CLAIMER_ROLE);
		FeeStorage.Layout storage f = FeeStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		uint256 amount = f.collectedOperatorFees[affiliate];
		if (amount == 0) revert LibErrors.NoOperatorFeesToClaim();
		f.collectedOperatorFees[affiliate] = 0;
		g.collateral.safeTransfer(to, amount);
		emit OperatorFeesClaimed(affiliate, amount);
	}

	// ── Sponsor management ──

	function depositSponsorBalance(address affiliate, uint256 amount) external {
		FeeStorage.Layout storage f = FeeStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		g.collateral.safeTransferFrom(msg.sender, address(this), amount);
		f.sponsorBalances[affiliate] += amount;
		if (f.sponsors[affiliate] == address(0)) {
			f.sponsors[affiliate] = msg.sender;
		}
		emit SponsorDeposit(affiliate, amount);
	}

	function withdrawSponsorBalance(address affiliate, uint256 amount, address to) external {
		LibAccessControl.enforceRole(LibAccessControl.SPONSOR_MANAGER_ROLE);
		FeeStorage.Layout storage f = FeeStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		if (f.sponsorBalances[affiliate] < amount) revert LibErrors.InsufficientSponsorBalance();
		f.sponsorBalances[affiliate] -= amount;
		g.collateral.safeTransfer(to, amount);
		emit SponsorWithdraw(affiliate, amount);
	}

	function setSponsorConfig(address affiliate, uint256 maxFeePerWithdraw, uint256 maxWithdrawAmount) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		FeeStorage.layout().sponsorConfigs[affiliate] = SponsorConfig(maxFeePerWithdraw, maxWithdrawAmount);
		emit SponsorConfigUpdated(affiliate, maxFeePerWithdraw, maxWithdrawAmount);
	}

	// ── General pool ──

	function depositToGeneral(uint256 amount) external {
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		g.collateral.safeTransferFrom(msg.sender, address(this), amount);
		p.generalBalance += amount;
		emit GeneralDeposit(amount);
	}

	function withdrawFromGeneral(uint256 amount) external {
		LibAccessControl.enforceRole(LibAccessControl.WITHDRAWER_ROLE);
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		uint256 available = p.generalBalance > p.lockedGeneralBalance ? p.generalBalance - p.lockedGeneralBalance : 0;
		if (available < amount) revert LibErrors.InsufficientUnlockedGeneralBalance();
		p.generalBalance -= amount;
		g.collateral.safeTransfer(msg.sender, amount);
		emit GeneralWithdraw(amount);
	}

	// ── Affiliate pool ──

	function depositToAffiliate(address affiliate, uint256 amount) external {
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		g.collateral.safeTransferFrom(msg.sender, address(this), amount);
		p.affiliateBalances[affiliate] += amount;
		emit AffiliateDeposit(affiliate, amount);
	}

	function withdrawFromAffiliate(address affiliate, uint256 amount) external {
		LibAccessControl.enforceRole(LibAccessControl.WITHDRAWER_ROLE);
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		if (p.affiliateBalances[affiliate] - p.lockedAffiliateBalances[affiliate] < amount) revert LibErrors.InsufficientUnlockedAffiliateBalance();
		p.affiliateBalances[affiliate] -= amount;
		g.collateral.safeTransfer(msg.sender, amount);
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
