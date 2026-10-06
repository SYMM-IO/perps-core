// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";

/// @notice Stand-in for the Symmio core diamond. `depositFor` pulls collateral from the caller and
///         credits a per-account ledger; `chargeOperationalFee` records the operational fee (and can
///         be made to fail, to exercise the gateway's atomic rollback).
contract MockGaslessSymmioCore is ISymmioCore {
	using SafeERC20 for IERC20;

	address public collateralToken;
	bool public forceChargeFailure;
	bool public enforceOperationalFeeAllowance;
	bool public enforceBalances;
	address public instantLayer;
	address public signerOverride;

	mapping(address => uint256) public accountBalance;
	mapping(address => uint256) public freeBalances;
	mapping(address => uint256) public allocatedBalances;
	mapping(address => uint256) public operationalFeesCharged;
	mapping(address => uint256) public operationalFeeChargeCount;
	mapping(address => mapping(address => uint256)) public operationalFeeAllowances;
	mapping(address => mapping(address => uint256)) public operationalFeeMultipliers;
	uint256 public totalOperationalFeesCharged;
	uint256 public totalOperationalFeeChargeCount;

	constructor(address collateralToken_) {
		collateralToken = collateralToken_;
	}

	function setForceChargeFailure(bool value) external {
		forceChargeFailure = value;
	}

	function setEnforceOperationalFeeAllowance(bool value) external {
		enforceOperationalFeeAllowance = value;
	}

	/// @notice Mirror the real core's balance behavior: charges draw free balance first, then allocated
	///         margin, and revert when both cannot cover the amount. Off by default so routing-focused
	///         tests can stay balance-agnostic.
	function setEnforceBalances(bool value) external {
		enforceBalances = value;
	}

	function setInstantLayer(address value) external {
		instantLayer = value;
	}

	function setSignerOverride(address value) external {
		require(msg.sender == instantLayer, "MockCore: not instant layer");
		signerOverride = value;
	}

	function setOperationalFeeMultiplier(address payer, address charger, uint256 feeMultiplier) external {
		operationalFeeMultipliers[payer][charger] = feeMultiplier;
	}

	/// @notice Test helper mirroring core free/allocated balances read by the gateway's payer-capacity check.
	function setCoreBalances(address account, uint256 freeBalance, uint256 allocatedBalance) external {
		freeBalances[account] = freeBalance;
		allocatedBalances[account] = allocatedBalance;
	}

	/// @notice Test helper to set a payer's allowance directly (approveOperationalFee uses msg.sender as payer).
	function setOperationalFeeAllowanceDirect(address payer, address charger, uint256 amount) external {
		operationalFeeAllowances[payer][charger] = amount;
	}

	function balanceOf(address user) external view returns (uint256) {
		return freeBalances[user];
	}

	function allocatedBalanceOfPartyA(address partyA) external view returns (uint256) {
		return allocatedBalances[partyA];
	}

	function getCollateral() external view returns (address) {
		return collateralToken;
	}

	function depositFor(address account, uint256 amount) external {
		IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), amount);
		accountBalance[account] += amount;
		// Keep the balance views coherent with deposits: deposited collateral is free balance on core.
		freeBalances[account] += amount;
	}

	function chargeOperationalFee(address payer, uint256 amount) external {
		require(!forceChargeFailure, "MockCore: charge failed");
		if (enforceOperationalFeeAllowance) {
			uint256 allowance = operationalFeeAllowances[payer][msg.sender];
			require(allowance >= amount, "MockCore: insufficient allowance");
			operationalFeeAllowances[payer][msg.sender] = allowance - amount;
		}
		if (enforceBalances) {
			uint256 free = freeBalances[payer];
			uint256 freeUsed = amount <= free ? amount : free;
			uint256 allocatedUsed = amount - freeUsed;
			require(allocatedBalances[payer] >= allocatedUsed, "MockCore: insufficient balance");
			freeBalances[payer] = free - freeUsed;
			allocatedBalances[payer] -= allocatedUsed;
		}
		operationalFeesCharged[payer] += amount;
		operationalFeeChargeCount[payer]++;
		totalOperationalFeesCharged += amount;
		totalOperationalFeeChargeCount++;
	}

	function approveOperationalFee(address[] calldata chargers, uint256[] calldata amounts) external {
		require(chargers.length == amounts.length, "MockCore: length mismatch");
		address payer = signerOverride == address(0) ? msg.sender : signerOverride;
		for (uint256 i = 0; i < chargers.length; i++) {
			operationalFeeAllowances[payer][chargers[i]] = amounts[i];
		}
	}

	function approveOperationalFeeWithMultiplier(
		address[] calldata chargers,
		uint256[] calldata amounts,
		uint256[] calldata feeMultipliers
	) external {
		require(chargers.length == amounts.length && chargers.length == feeMultipliers.length, "MockCore: length mismatch");
		address payer = signerOverride == address(0) ? msg.sender : signerOverride;
		for (uint256 i = 0; i < chargers.length; i++) {
			operationalFeeAllowances[payer][chargers[i]] = amounts[i];
			operationalFeeMultipliers[payer][chargers[i]] = feeMultipliers[i];
		}
	}

	function getOperationalFeeAllowance(
		address payer,
		address charger
	) external view returns (uint256 allowance, uint256 pendingAllowance, uint256 reductionReadyAt, uint256 feeMultiplier) {
		uint256 storedMultiplier = operationalFeeMultipliers[payer][charger];
		if (!enforceOperationalFeeAllowance) {
			return (type(uint256).max, 0, 0, storedMultiplier == 0 ? 10000 : storedMultiplier);
		}
		allowance = operationalFeeAllowances[payer][charger];
		feeMultiplier = storedMultiplier == 0 ? 10000 : storedMultiplier;
	}
}
