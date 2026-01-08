// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountLayerStorage } from "../storages/AccountLayerStorage.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

abstract contract AccountLayerPausable is IAccountLayerErrors {
	event Paused(address account);
	event Unpaused(address account);

	modifier whenNotPaused() {
		if (AccountLayerStorage.layout().globalPaused) revert EnforcedPause();
		_;
	}

	modifier whenPaused() {
		if (!AccountLayerStorage.layout().globalPaused) revert ExpectedPause();
		_;
	}

	function _pause() internal {
		AccountLayerStorage.layout().globalPaused = true;
		emit Paused(msg.sender);
	}

	function _unpause() internal {
		AccountLayerStorage.layout().globalPaused = false;
		emit Unpaused(msg.sender);
	}
}
