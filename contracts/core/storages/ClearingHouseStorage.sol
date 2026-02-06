// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Liquidation state for a cross-margin PartyB affecting all their counterparties
/// @dev Cross-margin (master account) PartyB liquidation is handled by the ClearingHouse
///      and affects all PartyAs at once.
///      inProgress prevents any actions with this PartyB during liquidation.
struct CrossLiquidationDetail {
	bytes liquidationId;
	int256 upnl;
	uint256 timestamp;
	uint256 deallocateForLiquidation;
	bool inProgress;
}

/// @notice Takeover state for a PartyA liquidation being handled by the ClearingHouse
/// @dev When a PartyA liquidation gets stuck (e.g., due to Muon signature issues),
///      the ClearingHouse can take over and manually complete the liquidation.
///      inProgress prevents normal liquidation functions from running.
///      Structure mirrors CrossLiquidationDetail for consistency.
struct PartyATakeoverDetail {
	bytes liquidationId;
	uint256 deallocatedPool;
	bool inProgress;
}

/// @title ClearingHouseStorage
/// @notice Storage for ClearingHouse operations: cross PartyB liquidation and PartyA takeover
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library ClearingHouseStorage {
	bytes32 internal constant CLEARING_HOUSE_STORAGE_SLOT = keccak256("diamond.standard.storage.clearinghouse");

	struct Layout {
		/// @notice Liquidation state for cross PartyBs
		/// @dev Similar to liquidationDetails but for cross-mode PartyB liquidation.
		mapping(address => CrossLiquidationDetail) crossLiquidationDetails;
		/// @notice Takeover state for PartyA liquidations
		/// @dev Maps partyA => PartyATakeoverDetail. When inProgress is true,
		///      the ClearingHouse has taken over the liquidation and normal
		///      liquidation functions are blocked.
		mapping(address => PartyATakeoverDetail) partyATakeoverDetails;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = CLEARING_HOUSE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
