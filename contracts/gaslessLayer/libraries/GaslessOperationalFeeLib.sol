// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer } from "../interfaces/ISymmioAccountLayer.sol";

/// @title GaslessOperationalFeeLib
/// @notice Operational-fee settlement with signer-VA fallback, plus quoting helpers for core-owned
///         operational-fee allowance state.
/// @dev External functions are DELEGATECALLed from the GaslessLayer proxy, so `address(this)` inside
///      them is the layer itself (the registered charger on core).
library GaslessOperationalFeeLib {
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;

	/// @notice One relayed operation's billing input, resolved by the layer after batch execution.
	/// @param signer The op's signer account (may be a virtual account).
	/// @param billingParent The signer's billing account (VA → parent SubAccount).
	/// @param baseFee Summed base selector fees before any core multiplier; 0 when the op is free-covered.
	struct OpBilling {
		address signer;
		address billingParent;
		uint256 baseFee;
	}

	/// @dev Per-payer working state for the greedy payer assignment. Caps are loaded lazily once per payer.
	struct PayerState {
		address payer;
		uint256 due;
		uint256 allowance;
		uint256 balanceCapacity;
		uint256 feeMultiplier;
	}

	// ─────────────────── Settlement (state-changing) ───────────────────

	/// @notice Assign each op's fee to a payer (billing parent first, signer-VA fallback), then charge
	///         every distinct payer once through core.
	/// @dev Greedy in op order: the billing parent pays while its remaining effective allowance AND
	///      free+allocated balance cover the running total. Once either cannot cover an op's fee, that op
	///      falls back to its own signer VA — only if the VA still exists on the account layer and its own
	///      allowance and balance cover the fee (priced with the VA's multiplier). When neither can pay,
	///      the fee stays on the parent so the core-side revert behavior is unchanged.
	/// @return totalFee Grand total charged across all payers.
	/// @return opPayers Per-op chosen payer, for the layer's per-op OperationalFeeRouted events.
	/// @return opFees Per-op charged amount (0 for free-covered ops).
	function settleOperationalFees(
		address core,
		address accountLayer,
		OpBilling[] memory ops
	) external returns (uint256 totalFee, address[] memory opPayers, uint256[] memory opFees) {
		PayerState[] memory states;
		uint256 stateCount;
		(states, stateCount, opPayers, opFees) = _planOperationalFees(core, accountLayer, ops);

		for (uint256 s = 0; s < stateCount; s++) {
			if (states[s].due > 0) {
				ISymmioCore(core).chargeOperationalFee(states[s].payer, states[s].due);
				totalFee += states[s].due;
			}
		}
	}

	/// @notice Read-only twin of settleOperationalFees: the per-op payer and fee the greedy assignment
	///         would choose right now. Fund-moving ops inside a batch can shift the split at execution.
	function planOperationalFees(
		address core,
		address accountLayer,
		OpBilling[] memory ops
	) external view returns (address[] memory opPayers, uint256[] memory opFees) {
		(, , opPayers, opFees) = _planOperationalFees(core, accountLayer, ops);
	}

	// ─────────────────── Quoting helpers ───────────────────

	/// @notice Quote an approval-only batch against the multiplier it establishes before fee collection.
	function postApprovalOperationalFee(
		address core,
		address account,
		address charger,
		bytes calldata callData,
		uint256 baseFee
	) external view returns (uint256 fee) {
		bytes4 selector = bytes4(callData[:4]);
		(, , , uint256 feeMultiplier) = ISymmioCore(core).getOperationalFeeAllowance(account, charger);
		if (selector == ISymmioCore.approveOperationalFeeWithMultiplier.selector) {
			(address[] memory chargers, uint256[] memory amounts, uint256[] memory feeMultipliers) = abi.decode(
				callData[4:],
				(address[], uint256[], uint256[])
			);
			if (chargers.length != amounts.length || chargers.length != feeMultipliers.length) revert IGaslessLayer.ArrayLengthMismatch();
			for (uint256 i = 0; i < chargers.length; i++) {
				if (chargers[i] == charger) {
					feeMultiplier = feeMultipliers[i] == 0 ? FEE_MULTIPLIER_BASE : feeMultipliers[i];
				}
			}
		}
		fee = (baseFee * feeMultiplier) / FEE_MULTIPLIER_BASE;
	}

	// ─────────────────── Internal: settlement plan ───────────────────

	/// @dev The settlement plan shared by settleOperationalFees (which executes it) and
	///      planOperationalFees (which exposes it): a greedy per-op payer choice returning the payer
	///      working set (with accumulated dues) plus the per-op assignment.
	function _planOperationalFees(
		address core,
		address accountLayer,
		OpBilling[] memory ops
	) private view returns (PayerState[] memory states, uint256 stateCount, address[] memory opPayers, uint256[] memory opFees) {
		uint256 n = ops.length;
		states = new PayerState[](2 * n);
		opPayers = new address[](n);
		opFees = new uint256[](n);

		for (uint256 i = 0; i < n; i++) {
			if (ops[i].baseFee == 0) {
				opPayers[i] = ops[i].billingParent; // free-covered or zero-fee: routed to the parent, nothing to price
				continue;
			}

			uint256 parentSlot;
			(parentSlot, stateCount) = _payerSlot(states, stateCount, core, ops[i].billingParent);

			uint256 parentFee = (ops[i].baseFee * states[parentSlot].feeMultiplier) / FEE_MULTIPLIER_BASE;
			if (_covers(states[parentSlot], parentFee)) {
				states[parentSlot].due += parentFee;
				opPayers[i] = ops[i].billingParent;
				opFees[i] = parentFee;
				continue;
			}

			// Parent cannot cover this op: fall back to the op's own signer VA when it still exists and
			// its own allowance and balance can fund the fee at its own multiplier.
			if (ops[i].signer != ops[i].billingParent && ISymmioAccountLayer(accountLayer).getVirtualAccount(ops[i].signer).isExists) {
				uint256 vaSlot;
				(vaSlot, stateCount) = _payerSlot(states, stateCount, core, ops[i].signer);
				uint256 vaFee = (ops[i].baseFee * states[vaSlot].feeMultiplier) / FEE_MULTIPLIER_BASE;
				if (_covers(states[vaSlot], vaFee)) {
					states[vaSlot].due += vaFee;
					opPayers[i] = ops[i].signer;
					opFees[i] = vaFee;
					continue;
				}
			}

			// Neither can pay: keep the fee on the parent so the core-side failure mode is unchanged.
			states[parentSlot].due += parentFee;
			opPayers[i] = ops[i].billingParent;
			opFees[i] = parentFee;
		}
	}

	function _covers(PayerState memory state, uint256 fee) private pure returns (bool) {
		return state.due + fee <= state.allowance && state.due + fee <= state.balanceCapacity;
	}

	/// @dev Find or create the working slot for `payer`, loading its caps from core on first touch.
	function _payerSlot(
		PayerState[] memory states,
		uint256 stateCount,
		address core,
		address payer
	) private view returns (uint256 slot, uint256 newStateCount) {
		for (slot = 0; slot < stateCount; slot++) {
			if (states[slot].payer == payer) return (slot, stateCount);
		}
		// The core view folds ready timelocked reductions into `allowance`, keeping this prediction
		// aligned with what chargeOperationalFee would accept.
		(uint256 allowance, , , uint256 feeMultiplier) = ISymmioCore(core).getOperationalFeeAllowance(payer, address(this));
		states[slot] = PayerState({
			payer: payer,
			due: 0,
			allowance: allowance,
			balanceCapacity: ISymmioCore(core).balanceOf(payer) + ISymmioCore(core).allocatedBalanceOfPartyA(payer),
			feeMultiplier: feeMultiplier
		});
		newStateCount = stateCount + 1;
	}
}
