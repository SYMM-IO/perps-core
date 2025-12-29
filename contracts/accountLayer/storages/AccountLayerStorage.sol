// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

library AccountLayerStorage {
	bytes32 internal constant ACCOUNT_LAYER_STORAGE_SLOT = keccak256("diamond.standard.storage.accountlayer");

	struct Layout {
		// Access control
		mapping(address => mapping(bytes32 => bool)) hasRole;
		mapping(bytes32 => mapping(address => bool)) roleAdmins;
		// Pause states
		bool globalPaused;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = ACCOUNT_LAYER_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
