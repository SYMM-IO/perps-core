// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountLayerStorage } from "../storages/AccountLayerStorage.sol";

abstract contract AccountLayerPausable {
	event Paused(address account);
	event Unpaused(address account);

	modifier whenNotPaused() {
		require(!AccountLayerStorage.layout().globalPaused, "AccountLayer: Paused");
		_;
	}

	modifier whenPaused() {
		require(AccountLayerStorage.layout().globalPaused, "AccountLayer: Not paused");
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
