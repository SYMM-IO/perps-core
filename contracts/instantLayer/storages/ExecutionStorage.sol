// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title ExecutionStorage
/// @notice Runtime state of the execution entry points: their reentrancy flag and the replay
///         tracking for signed operations.
/// @dev Slot-isolated from InstantLayerStorage, DelegationStorage and TemplateStorage so each
///      concern can evolve independently. Only the execution facet writes here.
library ExecutionStorage {
	bytes32 internal constant EXECUTION_STORAGE_SLOT = keccak256("diamond.standard.storage.instantlayer.execution");

	struct Layout {
		/// @notice Reentrancy guard flag for execution entry points.
		/// @dev 1 (not entered) / 2 (entered), checked and set by InstantLayerReentrancyGuard.
		///      Init seeds this to 1 so the slot is warm before the first executeBatch/executeTemplate
		///      call; the guard treats the field's zero default the same as 1, so seeding is a gas
		///      optimization, not a correctness requirement.
		uint256 reentrancyStatus;
		/// @notice Tracking of operation usage counts for replay protection.
		/// @dev Must be < maxUses to execute (or unlimited if maxUses=0).
		mapping(bytes32 => uint256) operationUsageCount;
		/// @notice Sequential nonce tracking per address for ordered execution.
		/// @dev Only enforced when nonce > 0 in operations.
		mapping(address => uint256) nonces;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = EXECUTION_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
