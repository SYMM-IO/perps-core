// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ExecutionStorage } from "../storages/ExecutionStorage.sol";
import { IInstantLayerErrors } from "../interfaces/IInstantLayerErrors.sol";

/// @notice Reentrancy protection for the InstantLayer diamond's execution entry points
/// @dev Modelled on AccountLayerReentrancyGuard: reads and writes
///      ExecutionStorage.layout().reentrancyStatus directly rather than a dedicated storage
///      slot constant, since ExecutionStorage.Layout already reserves that field for this
///      guard, but keeps the same 1 (not entered) / 2 (entered) value scheme AccountLayerReentrancyGuard
///      and OZ's ReentrancyGuard use. This is a gas choice, not a correctness one: 0/1 would pay a
///      20,000-gas SSTORE-from-zero on every executeBatch/executeTemplate call; 1/2 pays roughly
///      2,900 after the slot is warm. Init.init seeds the slot to 1 so it is warm from deployment.
///      A diamond whose Init never ran is still safe: from an unwritten (zero) slot, the enter
///      check `status == 2` reads false regardless, so first entry proceeds exactly as it would
///      from a seeded 1, sets the slot to 2, and a nested call within that same execution still
///      sees 2 and reverts. Init seeding only removes the one-time cold-slot cost; it is not load-
///      bearing for correctness.
abstract contract InstantLayerReentrancyGuard is IInstantLayerErrors {
	uint256 private constant _NOT_ENTERED = 1;
	uint256 private constant _ENTERED = 2;

	/// @notice Prevents reentrant calls to protected functions
	modifier nonReentrant() {
		ExecutionStorage.Layout storage l = ExecutionStorage.layout();
		if (l.reentrancyStatus == _ENTERED) revert ReentrancyGuardReentrantCall();
		l.reentrancyStatus = _ENTERED;
		_;
		l.reentrancyStatus = _NOT_ENTERED;
	}
}
