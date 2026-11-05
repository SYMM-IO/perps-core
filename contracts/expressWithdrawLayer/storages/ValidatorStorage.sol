// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title ValidatorStorage
/// @notice Diamond storage for per-affiliate validator configuration.
library ValidatorStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.validator");

	struct Layout {
		mapping(address => uint256) minValidatorSignatures;
		mapping(address => uint256) validatorApprovalTimeout;
		mapping(address => mapping(address => bool)) validators;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
