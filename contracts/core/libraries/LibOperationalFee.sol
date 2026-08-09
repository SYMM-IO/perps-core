// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../storages/AccountStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";
import { OperationalFeeStorage, AllowanceState } from "../storages/OperationalFeeStorage.sol";
import { LibAccount } from "./LibAccount.sol";
import { SharedEvents } from "./SharedEvents.sol";

library LibOperationalFee {
	uint256 internal constant DEFAULT_FEE_MULTIPLIER = 10000;

	function isCharger(address charger) internal view returns (bool) {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		return maLayout.partyBStatus[charger] || maLayout.operationalFeeChargers[charger];
	}

	function _applyReadyReduction(AllowanceState storage s) private {
		if (s.reductionReadyAt != 0 && block.timestamp >= s.reductionReadyAt) {
			s.allowance = s.pendingAllowance;
			s.pendingAllowance = 0;
			s.reductionReadyAt = 0;
		}
	}

	/// @notice Effective allowance for views (accounts for a ready-but-unapplied reduction).
	function effectiveAllowance(AllowanceState storage s) internal view returns (uint256) {
		if (s.reductionReadyAt != 0 && block.timestamp >= s.reductionReadyAt) return s.pendingAllowance;
		return s.allowance;
	}

	/// @notice Effective fee multiplier for views; unset storage means the default 1x multiplier.
	function effectiveFeeMultiplier(AllowanceState storage s) internal view returns (uint256) {
		return s.feeMultiplier == 0 ? DEFAULT_FEE_MULTIPLIER : s.feeMultiplier;
	}

	/// @notice Collect `amount` from `payer` for `feeReceiver`, using free balance before allocated margin.
	function _collectOperationalFee(address payer, address feeReceiver, uint256 amount) private returns (uint256 freeUsed, uint256 allocatedUsed) {
		AccountStorage.Layout storage a = AccountStorage.layout();
		uint256 free = a.balances[payer];
		freeUsed = amount <= free ? amount : free;
		if (freeUsed > 0) {
			a.balances[payer] -= freeUsed;
		}
		allocatedUsed = amount - freeUsed;
		if (allocatedUsed > 0) {
			require(a.allocatedBalances[payer] >= allocatedUsed, "OperationalFee: Insufficient balance");
			LibAccount.decreasePartyAAllocatedBalance(payer, allocatedUsed, SharedEvents.BalanceChangeType.OPERATIONAL_FEE_OUT);
		}
		a.balances[feeReceiver] += amount;
	}

	/// @notice Charges a standing operational fee from `payer` to `charger`'s receiver.
	/// @dev Payer guards live here so every charger path (solver, relayer, or future service) enforces
	///      the same protections: a charger must not be able to drain a suspended or under-liquidation payer.
	///      The not-liquidated check mirrors Accessibility.notLiquidatedPartyA (MAStorage.liquidationStatus).
	function charge(address payer, address charger, uint256 amount) internal returns (uint256 freeUsed, uint256 allocatedUsed) {
		require(amount > 0, "OperationalFee: Zero amount");
		require(isCharger(charger), "OperationalFee: Not a registered charger");
		require(!AccountStorage.layout().suspendedAddresses[payer], "OperationalFee: Payer suspended");
		require(!MAStorage.layout().liquidationStatus[payer], "OperationalFee: Payer liquidated");

		AllowanceState storage s = OperationalFeeStorage.layout().allowances[payer][charger];
		_applyReadyReduction(s);
		require(s.charged + amount <= s.allowance, "OperationalFee: Allowance exceeded");

		address feeReceiver = LibAccount.getOperationalFeeReceiver(charger);
		require(feeReceiver != payer, "OperationalFee: Receiver is payer");
		(freeUsed, allocatedUsed) = _collectOperationalFee(payer, feeReceiver, amount);
		s.charged += amount;
		emit SharedEvents.OperationalFeeCharged(payer, charger, feeReceiver, amount);
	}

	/// @notice Set/raise instantly; reductions schedule a timelocked pending change.
	/// @dev Setting `newAllowance` below the already-`charged` amount intentionally blocks all further charges
	///      from that charger until the payer raises the allowance back above `charged` (the `charged + amount <= allowance`
	///      check in `charge` then fails). This is intended: the payer can effectively freeze a charger via a low allowance.
	function setAllowance(address payer, address charger, uint256 newAllowance) internal {
		AllowanceState storage s = OperationalFeeStorage.layout().allowances[payer][charger];
		_applyReadyReduction(s);
		if (newAllowance >= s.allowance) {
			s.allowance = newAllowance;
			s.pendingAllowance = 0;
			s.reductionReadyAt = 0;
		} else {
			uint256 delay = MAStorage.layout().operationalFeeReductionDelay;
			if (delay == 0) {
				s.allowance = newAllowance;
				s.pendingAllowance = 0;
				s.reductionReadyAt = 0;
			} else {
				s.pendingAllowance = newAllowance;
				s.reductionReadyAt = block.timestamp + delay;
			}
		}
	}

	function setFeeMultiplier(address payer, address charger, uint256 feeMultiplier) internal {
		OperationalFeeStorage.layout().allowances[payer][charger].feeMultiplier = feeMultiplier;
	}
}
