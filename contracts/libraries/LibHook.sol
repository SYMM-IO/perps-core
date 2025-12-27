// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

library LibHook {
	bytes4 internal constant HOOK_FAILED_SELECTOR = bytes4(keccak256("HookFailed(bytes)"));

	function revertIfHookFailed(bytes memory data) internal pure {
		if (data.length < 4) return;

		bytes4 selector;
		assembly {
			selector := mload(add(data, 32))
		}

		if (selector == HOOK_FAILED_SELECTOR) {
			assembly {
				revert(add(data, 32), mload(data))
			}
		}
	}
}
