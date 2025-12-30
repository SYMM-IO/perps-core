// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

abstract contract AccountLayerReentrancyGuard {
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

	modifier nonReentrant() {
		require(_getReentrancyStatus() != _ENTERED, "ReentrancyGuard: reentrant call");
		_setReentrancyStatus(_ENTERED);
		_;
		_setReentrancyStatus(_NOT_ENTERED);
	}
}
