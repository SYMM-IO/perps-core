// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Settlement metadata kept outside existing public liquidation tuples and storage layouts.
library LiquidationSettlementStorage {
	bytes32 internal constant STORAGE_SLOT = keccak256("diamond.standard.storage.liquidation-settlement");

	struct Allocation {
		address key;
		bool isSet;
	}

	struct Netting {
		bool enabled;
		bool finalized;
		address[] partyBs;
		uint256 totalNetLoss;
	}

	struct Layout {
		mapping(address partyA => mapping(address partyB => Allocation)) allocations;
		mapping(address partyA => Netting) netting;
		mapping(address partyA => mapping(address partyB => bool)) overridden;
		mapping(address partyA => bool) processing;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
