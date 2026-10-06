// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";
import { LibAccountLayerSigner } from "./LibAccountLayerSigner.sol";

/// @title LibAccountLayerSafeCall
/// @notice Library for safely calling external contracts with signer protection
/// @dev Clears the globalSigner before calling external contracts to prevent impersonation attacks
library LibAccountLayerSafeCall {
	/// @notice Safely calls an external contract with signer cleared, reverts on failure
	/// @dev Prevents external contracts from calling back and impersonating the user via getSigner()
	/// @param target The target contract address
	/// @param data The encoded function call data
	function safeExternalCall(address target, bytes memory data) internal {
		if (target == address(0)) revert IAccountLayerErrors.ZeroAddress();

		// Save and clear signer before external call to prevent target from impersonating user
		(address previousSigner, bool wasTransientScoped) = LibAccountLayerSigner.clearSignerForExternalCall();

		(bool success, bytes memory reason) = target.call(data);

		// Restore signer after external call
		LibAccountLayerSigner.restoreSignerAfterExternalCall(previousSigner, wasTransientScoped);

		// Revert with the original error if the call failed
		if (!success) {
			if (reason.length > 0) {
				assembly {
					revert(add(reason, 32), mload(reason))
				}
			} else {
				revert IAccountLayerErrors.ExternalCallFailed();
			}
		}
	}
}
