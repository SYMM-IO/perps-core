// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Template } from "../InstantLayerTypes.sol";

/// @title TemplateStorage
/// @notice Operation templates and template-scoped execution flags for InstantLayer.
/// @dev Slot-isolated from InstantLayerStorage, ExecutionStorage and DelegationStorage so each
///      concern can evolve independently.
library TemplateStorage {
	bytes32 internal constant TEMPLATE_STORAGE_SLOT = keccak256("diamond.standard.storage.instantlayer.template");

	struct Layout {
		/// @notice Storage for all operation templates indexed by template ID.
		mapping(uint256 => Template) templates;
		/// @notice Templates that skip pending balance tracking (send+lock+open flows).
		mapping(uint256 => bool) templateInstantOpenMode;
		/// @notice Counter for generating unique sequential template IDs.
		uint256 nextTemplateId;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = TEMPLATE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
