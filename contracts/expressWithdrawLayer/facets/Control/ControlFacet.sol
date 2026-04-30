// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { AffiliateConfig, SponsorConfig } from "../../types/ConfigTypes.sol";
import { AffiliateCredit } from "../../types/CreditTypes.sol";

import { LibAccessControl } from "../../libraries/LibAccessControl.sol";
import { LibCreditLine } from "../../libraries/LibCreditLine.sol";
import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";
import { LibErrors } from "../../libraries/LibErrors.sol";

import { CreditLineStorage } from "../../storages/CreditLineStorage.sol";
import { GlobalStorage } from "../../storages/GlobalStorage.sol";
import { PoolStorage } from "../../storages/PoolStorage.sol";
import { FeeStorage } from "../../storages/FeeStorage.sol";
import { ValidatorStorage } from "../../storages/ValidatorStorage.sol";

import { IControlFacet } from "./IControlFacet.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { ReentrancyGuard } from "../../utils/ReentrancyGuard.sol";

contract ControlFacet is IControlFacet, Pausable, ReentrancyGuard {
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

	// ── Credit line setters ──

	function setCreditLineMuonConfig(address signatureVerifier, uint256 muonAppId, uint256 muonFreshnessWindow) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.Layout storage cl = CreditLineStorage.layout();
		cl.signatureVerifier = signatureVerifier;
		cl.muonAppId = muonAppId;
		cl.muonFreshnessWindow = muonFreshnessWindow;
		emit CreditLineMuonConfigUpdated(signatureVerifier, muonAppId, muonFreshnessWindow);
	}

	function setCreditLineProtocolConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		ac.protocolMaxDebt = maxDebt;
		ac.protocolMaxDebtBps = maxDebtBps;
		emit CreditLineProtocolConfigUpdated(affiliate, maxDebt, maxDebtBps);
	}

	function setCreditLineAffiliateConfig(address affiliate, uint256 maxDebt, uint256 maxDebtBps) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];

		// Affiliate limits must be stricter (or equal) to protocol limits
		if (ac.protocolMaxDebt > 0 && maxDebt > ac.protocolMaxDebt) revert LibCreditLine.AffiliateLimitExceedsProtocol();
		if (ac.protocolMaxDebtBps > 0 && maxDebtBps > ac.protocolMaxDebtBps) revert LibCreditLine.AffiliateLimitExceedsProtocol();

		ac.affiliateMaxDebt = maxDebt;
		ac.affiliateMaxDebtBps = maxDebtBps;
		emit CreditLineAffiliateConfigUpdated(affiliate, maxDebt, maxDebtBps);
	}

	/// @notice Self-service cap adjustment for an affiliate. Decreases are always free;
	///         increases count against the per-window free allowance and charge a fee once exhausted.
	///         msg.sender is treated as the affiliate identity.
	function setMyCreditLineConfig(uint256 maxDebt, uint256 maxDebtBps) external whenNotPaused {
		address affiliate = msg.sender;
		CreditLineStorage.Layout storage cl = CreditLineStorage.layout();
		AffiliateCredit storage ac = cl.affiliates[affiliate];

		// Preserve protocol-cap invariant
		if (ac.protocolMaxDebt > 0 && maxDebt > ac.protocolMaxDebt) revert LibCreditLine.AffiliateLimitExceedsProtocol();
		if (ac.protocolMaxDebtBps > 0 && maxDebtBps > ac.protocolMaxDebtBps) revert LibCreditLine.AffiliateLimitExceedsProtocol();

		uint256 oldMaxDebt = ac.affiliateMaxDebt;
		uint256 oldMaxDebtBps = ac.affiliateMaxDebtBps;

		if (oldMaxDebt == maxDebt && oldMaxDebtBps == maxDebtBps) revert LibErrors.NoOpCapChange();

		bool isDecrease = _isDecreaseCapChange(oldMaxDebt, oldMaxDebtBps, maxDebt, maxDebtBps);
		uint256 feePaid = 0;
		if (!isDecrease) {
			feePaid = _applyCapChangeThrottleAndFee(cl, ac, affiliate);
		}

		ac.affiliateMaxDebt = maxDebt;
		ac.affiliateMaxDebtBps = maxDebtBps;

		emit CreditLineAffiliateConfigSelfUpdated(affiliate, maxDebt, maxDebtBps, isDecrease, feePaid);
		emit CreditLineAffiliateConfigUpdated(affiliate, maxDebt, maxDebtBps);
	}

	function setCapChangeFeeConfig(address feeToken, uint256 feeAmount, address feeReceiver) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.Layout storage cl = CreditLineStorage.layout();
		cl.capChangeFeeToken = feeToken;
		cl.capChangeFeeAmount = feeAmount;
		cl.capChangeFeeReceiver = feeReceiver;
		emit CapChangeFeeConfigUpdated(feeToken, feeAmount, feeReceiver);
	}

	function setCapChangeQuotaConfig(uint256 maxFreePerWindow, uint256 windowDuration) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.Layout storage cl = CreditLineStorage.layout();
		cl.capChangeMaxFreePerWindow = maxFreePerWindow;
		cl.capChangeWindowDuration = windowDuration;
		emit CapChangeQuotaConfigUpdated(maxFreePerWindow, windowDuration);
	}

	/// @dev Treats 0 as "no cap" (effectively infinity) when comparing old vs new values.
	///      Returns true iff neither dimension loosens.
	function _isDecreaseCapChange(uint256 oldMax, uint256 oldBps, uint256 newMax, uint256 newBps) internal pure returns (bool) {
		uint256 oldMaxCmp = oldMax == 0 ? type(uint256).max : oldMax;
		uint256 newMaxCmp = newMax == 0 ? type(uint256).max : newMax;
		uint256 oldBpsCmp = oldBps == 0 ? type(uint256).max : oldBps;
		uint256 newBpsCmp = newBps == 0 ? type(uint256).max : newBps;
		return newMaxCmp <= oldMaxCmp && newBpsCmp <= oldBpsCmp;
	}

	function _applyCapChangeThrottleAndFee(
		CreditLineStorage.Layout storage cl,
		AffiliateCredit storage ac,
		address affiliate
	) internal returns (uint256 feePaid) {
		// If quota is unconfigured (windowDuration == 0), treat all increases as free — feature dormant.
		if (cl.capChangeWindowDuration == 0) {
			return 0;
		}

		// Epoch reset
		if (block.timestamp >= ac.capChangeEpochStart + cl.capChangeWindowDuration) {
			ac.capChangeCount = 0;
			ac.capChangeEpochStart = block.timestamp;
		}

		ac.capChangeCount++;

		if (ac.capChangeCount <= cl.capChangeMaxFreePerWindow) {
			return 0;
		}

		if (cl.capChangeFeeToken == address(0) || cl.capChangeFeeAmount == 0 || cl.capChangeFeeReceiver == address(0)) {
			revert LibErrors.CapChangeFeeNotConfigured();
		}

		IERC20(cl.capChangeFeeToken).safeTransferFrom(affiliate, cl.capChangeFeeReceiver, cl.capChangeFeeAmount);
		return cl.capChangeFeeAmount;
	}

	function setCreditLinePaused(address affiliate, bool paused) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.layout().affiliates[affiliate].paused = paused;
		emit CreditLinePausedUpdated(affiliate, paused);
	}

	function setCreditLineBlacklisted(address affiliate, address user, bool blacklisted) external {
		LibAccessControl.enforceRole(LibAccessControl.SETTER_ROLE);
		CreditLineStorage.layout().affiliates[affiliate].blacklisted[user] = blacklisted;
		emit CreditLineUserBlacklistUpdated(affiliate, user, blacklisted);
	}

	// ── Fee claims ──

	function claimFees(address affiliate, address to) external nonReentrant whenNotPaused {
		LibAccessControl.enforceRole(LibAccessControl.FEE_CLAIMER_ROLE);
		FeeStorage.Layout storage f = FeeStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		uint256 amount = f.collectedFees[affiliate];
		if (amount == 0) revert LibErrors.NoFeesToClaim();
		f.collectedFees[affiliate] = 0;
		g.collateral.safeTransfer(to, amount);
		emit FeesClaimed(affiliate, amount);
	}

	function claimOperatorFees(address affiliate, address to) external nonReentrant whenNotPaused {
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

	function depositSponsorBalance(address affiliate, uint256 amount) external whenNotPaused {
		FeeStorage.Layout storage f = FeeStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		g.collateral.safeTransferFrom(msg.sender, address(this), amount);
		f.sponsorBalances[affiliate] += amount;
		if (f.sponsors[affiliate] == address(0)) {
			f.sponsors[affiliate] = msg.sender;
		}
		emit SponsorDeposit(affiliate, amount);
	}

	function withdrawSponsorBalance(address affiliate, uint256 amount, address to) external nonReentrant whenNotPaused {
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

	function depositToGeneral(uint256 amount) external whenNotPaused {
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		g.collateral.safeTransferFrom(msg.sender, address(this), amount);
		p.generalBalance += amount;
		emit GeneralDeposit(amount);
	}

	function withdrawFromGeneral(uint256 amount) external nonReentrant whenNotPaused {
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

	function depositToAffiliate(address affiliate, uint256 amount) external whenNotPaused {
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		g.collateral.safeTransferFrom(msg.sender, address(this), amount);
		p.affiliateBalances[affiliate] += amount;
		emit AffiliateDeposit(affiliate, amount);
	}

	function withdrawFromAffiliate(address affiliate, uint256 amount) external nonReentrant whenNotPaused {
		LibAccessControl.enforceRole(LibAccessControl.WITHDRAWER_ROLE);
		PoolStorage.Layout storage p = PoolStorage.layout();
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		uint256 bal = p.affiliateBalances[affiliate];
		uint256 locked = p.lockedAffiliateBalances[affiliate];
		uint256 available = bal > locked ? bal - locked : 0;
		if (available < amount) revert LibErrors.InsufficientUnlockedAffiliateBalance();
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

	// ── Emergency recovery ──

	function rescueTokens(address token, address to, uint256 amount) external nonReentrant {
		LibDiamond.enforceIsContractOwner();
		IERC20(token).safeTransfer(to, amount);
		emit TokensRescued(token, to, amount);
	}

	/// @notice PAUSER_ROLE kill switch
	function setPaused(bool value) external {
		LibAccessControl.enforceRole(LibAccessControl.PAUSER_ROLE);
		GlobalStorage.layout().paused = value;
		emit PausedUpdated(value);
	}

	/// @notice Owner-only. Zeros a stuck per-request credit debt entry and decrements
	///         `reservedDebt` or `activeDebt` by the exact amount, consistent with activation state.
	function clearRequestDebt(address affiliate, address user, uint256 requestId) external {
		LibDiamond.enforceIsContractOwner();
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		bytes32 key = keccak256(abi.encodePacked(user, requestId));
		uint256 amount = ac.requestDebt[key];
		if (amount == 0) return;
		bool wasActivated = ac.requestActivated[key];
		if (wasActivated) {
			ac.activeDebt -= amount;
		} else {
			ac.reservedDebt -= amount;
		}
		delete ac.requestDebt[key];
		delete ac.requestActivated[key];
		emit RequestDebtCleared(affiliate, user, requestId, amount, wasActivated);
	}

	/// @notice Repays accrued bad debt for an affiliate. Pulls `amount` collateral from the
	///         caller, decrements `badDebt`, and credits the affiliate pool. Permissionless —
	///         anyone willing to pay can restore the affiliate's credit capacity.
	function repayCreditBadDebt(address affiliate, uint256 amount) external nonReentrant whenNotPaused {
		AffiliateCredit storage ac = CreditLineStorage.layout().affiliates[affiliate];
		if (amount == 0 || amount > ac.badDebt) revert LibErrors.InvalidRepayAmount();
		ac.badDebt -= amount;
		PoolStorage.layout().affiliateBalances[affiliate] += amount;
		GlobalStorage.layout().collateral.safeTransferFrom(msg.sender, address(this), amount);
		emit CreditBadDebtRepaid(affiliate, msg.sender, amount);
	}
}
