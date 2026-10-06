// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";
import { LibAccountLayerSigner } from "../libraries/LibAccountLayerSigner.sol";

/// @notice Reentrancy protection for the AccountLayer diamond using a dedicated storage slot
abstract contract AccountLayerReentrancyGuard is IAccountLayerErrors {
	uint256 private constant _NOT_ENTERED = 1;
	uint256 private constant _ENTERED = 2;

	// Using a specific storage slot for reentrancy guard
	bytes32 private constant REENTRANCY_GUARD_SLOT = keccak256("diamond.standard.storage.accountlayer.reentrancy");

	function _getReentrancyStatus() private view returns (uint256 status) {
		bytes32 slot = REENTRANCY_GUARD_SLOT;
		assembly {
			status := sload(slot)
		}
	}

	function _setReentrancyStatus(uint256 status) private {
		bytes32 slot = REENTRANCY_GUARD_SLOT;
		assembly {
			sstore(slot, status)
		}
	}

	/// @notice Prevents reentrant calls to protected functions
	modifier nonReentrant() {
		if (_getReentrancyStatus() == _ENTERED) revert ReentrancyGuardReentrantCall();
		_setReentrancyStatus(_ENTERED);
		_;
		_setReentrancyStatus(_NOT_ENTERED);
	}

	/// @notice Protects core-originated callbacks while permitting one expected callback through an active forwarding boundary.
	/// @dev Direct callbacks acquire the ordinary guard. During a guarded AccountLayer-to-core call, only the exact core marked
	///      by that call boundary may enter, and callback nesting remains forbidden. Ordinary nonReentrant functions stay locked
	///      for the entire outer call and callback cleanup.
	modifier nonReentrantCallback() {
		bool outerGuardActive = _getReentrancyStatus() == _ENTERED;
		if (outerGuardActive && LibAccountLayerSigner.expectedCallbackCore() != msg.sender) revert ReentrancyGuardReentrantCall();
		if (LibAccountLayerSigner.isCallbackActive()) revert ReentrancyGuardReentrantCall();

		if (!outerGuardActive) _setReentrancyStatus(_ENTERED);
		LibAccountLayerSigner.setCallbackActive(true);
		_;
		LibAccountLayerSigner.setCallbackActive(false);
		if (!outerGuardActive) _setReentrancyStatus(_NOT_ENTERED);
	}
}
