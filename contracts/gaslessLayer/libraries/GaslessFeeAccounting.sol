// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";

/// @notice Collect actual charges while simulating or executing a call with a caller-supplied debit limit.
/// @dev Internal only. The isolated namespace does not consume or change the proxy's existing storage slots.
library GaslessFeeAccounting {
	bytes32 private constant SLOT = keccak256("symmio.gaslessLayer.feeQuote.v1");
	struct State {
		bool active;
		IGaslessLayer.FeePayment[] payments;
		uint256 freeOps;
		bool nativeSponsored;
	}
	function state() internal pure returns (State storage s) {
		bytes32 slot = SLOT;
		assembly ("memory-safe") {
			s.slot := slot
		}
	}
	function record(IGaslessLayer.FeePayment memory payment) internal {
		State storage s = state();
		if (s.active) s.payments.push(payment);
	}
	function freeOperation() internal {
		State storage s = state();
		if (s.active) s.freeOps++;
	}
	function sponsored() internal {
		State storage s = state();
		if (s.active) s.nativeSponsored = true;
	}
	function clear() internal {
		State storage s = state();
		delete s.payments;
		s.freeOps = 0;
		s.nativeSponsored = false;
		s.active = false;
	}
}
