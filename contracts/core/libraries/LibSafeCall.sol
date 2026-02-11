// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { GlobalAppStorage } from "../storages/GlobalAppStorage.sol";

/// @title LibSafeCall
/// @notice Library for safely calling external contracts with signer protection
/// @dev Clears the signer before calling external contracts to prevent impersonation attacks
library LibSafeCall {
	/// @notice Safely calls an external contract with signer cleared, reverts on failure
	/// @dev Unlike LibHook.safeCall, this reverts if the external call fails
	/// @param target The target contract address
	/// @param data The encoded function call data
	function safeExternalCall(address target, bytes memory data) internal {
		GlobalAppStorage.Layout storage globalLayout = GlobalAppStorage.layout();
		require(target != address(0), "LibSafeCall: Zero address");

		// Save and clear signer before external call to prevent target from impersonating user
		address previousSigner = globalLayout.signer;
		globalLayout.signer = address(0);

		(bool success, bytes memory reason) = target.call(data);

		// Restore signer after external call
		globalLayout.signer = previousSigner;

		// Revert with the original error if the call failed
		if (!success) {
			if (reason.length > 0) {
				assembly {
					revert(add(reason, 32), mload(reason))
				}
			} else {
				revert("LibSafeCall: External call failed");
			}
		}
	}
}
