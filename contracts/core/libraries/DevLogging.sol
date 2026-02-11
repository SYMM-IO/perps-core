// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Development-only logging library for debugging contract state.
library DevLogging {
	/// @notice Emitted to log a uint256 value during development.
	event LogUint(uint256 value);
	/// @notice Emitted to log an int256 value during development.
	event LogInt(int256 value);
	/// @notice Emitted to log an address value during development.
	event LogAddress(address value);
	/// @notice Emitted to log a string value during development.
	event LogString(string value);
}

/// @notice Interface mirroring DevLogging events for ABI generation.
interface DevLoggingInterface {
	/// @notice Emitted to log a uint256 value during development.
	event LogUint(uint256 value);
	/// @notice Emitted to log an int256 value during development.
	event LogInt(int256 value);
	/// @notice Emitted to log an address value during development.
	event LogAddress(address value);
	/// @notice Emitted to log a string value during development.
	event LogString(string value);
}
