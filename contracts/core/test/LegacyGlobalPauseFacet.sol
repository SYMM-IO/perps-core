// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import { Accessibility } from "../utils/Accessibility.sol";
import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";

/// @dev Test fixture for the global pause gate on pre-granular Core deployments.
contract LegacyGlobalPauseFacet is Accessibility {
	event PauseGlobal();

	function pauseGlobal() external onlyRole(keccak256("PAUSER_ROLE")) {
		GlobalAppStorage.layout().globalPaused = true;
		emit PauseGlobal();
	}
}
