// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";
import { ISymmioAccountLayer } from "../interfaces/ISymmioAccountLayer.sol";
import { GaslessFeeAccounting } from "./GaslessFeeAccounting.sol";

/// @title GaslessOperationalFeeLib
/// @notice Settle operational fees with signer-VA fallback and quote fees using core's allowance state.
/// @dev GaslessLayer calls external functions through delegatecall. `address(this)` is the proxy registered as a charger on core.
library GaslessOperationalFeeLib {
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;

	/// @notice One relayed operation's billing input, resolved by the layer after batch execution.
	/// @param signer The op's signer account (may be a virtual account).
	/// @param billingParent The signer's billing account (VA → parent SubAccount).
	/// @param baseFee Sum of selector fees before any core multiplier; 0 when the free quota covers the operation.
	/// @param creationFee Flat wallet creation fee in Core's 18 decimals, unaffected by the selector multiplier or free-operation quota.
	struct OpBilling {
		address signer;
		address billingParent;
		uint256 baseFee;
		uint256 creationFee;
	}

	/// @dev Track each payer's total due and limits while assigning fees in operation order. Load limits once per payer.
	struct PayerState {
		address payer;
		uint256 due;
		uint256 allowance;
		uint256 balanceCapacity;
		uint256 feeMultiplier;
	}

	// ─────────────────── Settlement (state-changing) ───────────────────

	/// @notice Assign fees to the billing parent or signer VA, then charge each payer once through core.
	/// @dev Process operations in order. The parent pays while its effective allowance and free plus allocated
	///      balance cover its running total. Otherwise, try the signer VA if it still exists on the account layer
	///      and its allowance and balance cover the fee at its own multiplier. If neither can pay, leave the fee
	///      on the parent so core reverts as usual.
	/// @return totalFee Total charged across all payers.
	/// @return opPayers Payer for each operation, used in the layer's OperationalFeeRouted events.
	/// @return opFees Fee for each operation, including any wallet creation fee.
	function settleOperationalFees(
		address core,
		address accountLayer,
		OpBilling[] memory ops
	) external returns (uint256 totalFee, address[] memory opPayers, uint256[] memory opFees) {
		PayerState[] memory states;
		uint256 stateCount;
		(states, stateCount, opPayers, opFees) = _planOperationalFees(core, accountLayer, ops);
		for (uint256 i; i < ops.length; i++) {
			GaslessFeeAccounting.record(
				IGaslessLayer.FeePayment(
					ops[i].signer,
					opPayers[i],
					uint8(IGaslessLayer.FeeSource.SYMMIO_ACCOUNT),
					opFees[i] - ops[i].creationFee,
					0,
					ops[i].creationFee,
					0,
					0
				)
			);
		}

		for (uint256 s = 0; s < stateCount; s++) {
			if (states[s].due > 0) {
				ISymmioCore(core).chargeOperationalFee(states[s].payer, states[s].due);
				totalFee += states[s].due;
			}
		}
	}

	/// @notice Quote the payer and fee for each operation using the same rules as settleOperationalFees.
	/// @dev Uses current state. Operations that move funds within the batch can change which account pays at execution.
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

	/// @dev Assign payers in operation order and accumulate their fees. Used by settleOperationalFees and planOperationalFees.
	///      Return each payer's total due and each operation's payer and fee.
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
			if (ops[i].baseFee == 0 && ops[i].creationFee == 0) {
				opPayers[i] = ops[i].billingParent; // Record the parent for operations covered by the quota or priced at zero.
				continue;
			}

			uint256 parentSlot;
			(parentSlot, stateCount) = _payerSlot(states, stateCount, core, ops[i].billingParent);

			uint256 parentFee = (ops[i].baseFee * states[parentSlot].feeMultiplier) / FEE_MULTIPLIER_BASE + ops[i].creationFee;
			if (_covers(states[parentSlot], parentFee)) {
				states[parentSlot].due += parentFee;
				opPayers[i] = ops[i].billingParent;
				opFees[i] = parentFee;
				continue;
			}

			// Try the signer VA if it still exists and its allowance and balance cover the fee at its own multiplier.
			if (ops[i].signer != ops[i].billingParent && ISymmioAccountLayer(accountLayer).getVirtualAccount(ops[i].signer).isExists) {
				uint256 vaSlot;
				(vaSlot, stateCount) = _payerSlot(states, stateCount, core, ops[i].signer);
				uint256 vaFee = (ops[i].baseFee * states[vaSlot].feeMultiplier) / FEE_MULTIPLIER_BASE + ops[i].creationFee;
				if (_covers(states[vaSlot], vaFee)) {
					states[vaSlot].due += vaFee;
					opPayers[i] = ops[i].signer;
					opFees[i] = vaFee;
					continue;
				}
			}

			// Neither account can pay. Leave the fee on the parent so core reverts as usual.
			states[parentSlot].due += parentFee;
			opPayers[i] = ops[i].billingParent;
			opFees[i] = parentFee;
		}
	}

	function _covers(PayerState memory state, uint256 fee) private pure returns (bool) {
		return state.due + fee <= state.allowance && state.due + fee <= state.balanceCapacity;
	}

	/// @dev Find or create the state entry for `payer`; load its limits from core when creating the entry.
	function _payerSlot(
		PayerState[] memory states,
		uint256 stateCount,
		address core,
		address payer
	) private view returns (uint256 slot, uint256 newStateCount) {
		for (slot = 0; slot < stateCount; slot++) {
			if (states[slot].payer == payer) return (slot, stateCount);
		}
		// The core view applies ready timelocked reductions to `allowance`, as chargeOperationalFee does.
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
