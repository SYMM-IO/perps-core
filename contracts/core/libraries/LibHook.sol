// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { MAStorage } from "../storages/MAStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";

/**
 * @title LibHook
 * @notice Library for safely calling hooks with signer protection
 * @dev Clears the signer before calling hooks to prevent hooks from impersonating users
 */
library LibHook {
	/// @dev Reverts when a hook fails.
	error HookReverted(address hook, bytes4 selector, uint256 quoteId, bytes reason);

	/**
	 * @notice Safely calls a hook with signer cleared
	 * @dev Clears signer before call to prevent impersonation attacks, restores after
	 * @param hook The hook contract address
	 * @param data The encoded function call data
	 * @param quoteId The quote ID for event emission on failure
	 */
	function safeCall(address hook, bytes memory data, uint256 quoteId) internal {
		if (hook == address(0)) return;

		// Save and clear signer before external call to prevent hook from impersonating user
		address previousSigner = MAStorage.layout().signer;
		MAStorage.layout().signer = address(0);

		(bool success, bytes memory reason) = hook.call(data);

		// NOTE: We intentionally revert on hook failures for now to avoid inconsistency
		if (!success) {
			revert HookReverted(hook, bytes4(data), quoteId, reason);
		}

		// Restore signer after hook call
		MAStorage.layout().signer = previousSigner;
	}
}
