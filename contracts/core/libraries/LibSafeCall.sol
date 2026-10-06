// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LibExecutionContext } from "./LibExecutionContext.sol";

/// @title LibSafeCall
/// @notice Library for safely calling external contracts with signer protection
/// @dev Clears the signer before calling external contracts to prevent impersonation attacks
library LibSafeCall {
	/// @notice Safely calls an external contract with signer cleared, reverts on failure
	/// @dev Reverts if the target is address(0) or if the external call fails, preserving the original error.
	///      Unlike LibHook.safeCall, this function does not ignore failures.
	/// @param target The target contract address
	/// @param data The encoded function call data
	function safeExternalCall(address target, bytes memory data) internal {
		require(target != address(0), "LibSafeCall: Zero address");

		// Save and clear signer before external call to prevent target from impersonating user
		(address previousSigner, bool wasTransientScoped) = LibExecutionContext.clearSignerForExternalCall();

		(bool success, bytes memory reason) = target.call(data);

		// Restore signer after external call
		LibExecutionContext.restoreSignerAfterExternalCall(previousSigner, wasTransientScoped);

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
