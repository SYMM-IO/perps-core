// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity ^0.8.0;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Symmio governance timelock controller for delayed execution of admin operations
contract SymmioTimelockController is TimelockController {
	/// @notice Initializes the timelock with delay, proposers, executors, and admin
	/// @param minDelay Minimum delay in seconds before a queued operation can be executed
	/// @param proposers Addresses allowed to propose operations
	/// @param executors Addresses allowed to execute operations
	/// @param admin Address that will receive the admin role
	constructor(
		uint256 minDelay,
		address[] memory proposers,
		address[] memory executors,
		address admin
	) TimelockController(minDelay, proposers, executors, admin) {}
}
