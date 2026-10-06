// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountLayerStorage } from "../storages/AccountLayerStorage.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

/// @notice Pause control for the AccountLayer diamond
abstract contract AccountLayerPausable is IAccountLayerErrors {
	/// @notice Emitted when the account layer is paused
	event Paused(address account);
	/// @notice Emitted when the account layer is unpaused
	event Unpaused(address account);

	/// @notice Restricts access to when the account layer is not paused
	modifier whenNotPaused() {
		if (AccountLayerStorage.layout().globalPaused) revert EnforcedPause();
		_;
	}

	/// @notice Restricts access to when the account layer is paused
	modifier whenPaused() {
		if (!AccountLayerStorage.layout().globalPaused) revert ExpectedPause();
		_;
	}

	/// @notice Sets the global pause state to true
	function _pause() internal {
		AccountLayerStorage.layout().globalPaused = true;
		emit Paused(msg.sender);
	}

	/// @notice Sets the global pause state to false
	function _unpause() internal {
		AccountLayerStorage.layout().globalPaused = false;
		emit Unpaused(msg.sender);
	}
}
