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

/// @title CrossPartyBStorage
/// @notice Master account / cross-margin mode for PartyBs
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library CrossPartyBStorage {
	bytes32 internal constant CROSS_PARTY_B_STORAGE_SLOT = keccak256("diamond.standard.storage.crosspartyb");

	struct Layout {
		/// @notice Master switch for cross (master account) mode
		/// @dev When false, PartyBs cannot activate cross mode. This is the global
		///      gate - individual PartyBs still need to activate separately.
		///      Once activated, turning this off doesn't affect existing
		///      cross PartyBs.
		bool crossPartyBModeActivated;
		/// @notice Whether a PartyB is operating in cross (master account) mode
		/// @dev Cross-margin PartyBs have one shared balance across all PartyAs instead of
		///      isolated per-PartyA allocations. When true, uses address(0) for allocation
		///      mappings and has different liquidation flow via ClearingHouse.
		mapping(address => bool) crossModeEnabledForPartyB;
		/// @notice Liquidation state for cross PartyBs
		/// @dev Similar to liquidationDetails but for cross-mode PartyB liquidation.
		mapping(address => CrossLiquidationDetail) crossLiquidationDetails;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = CROSS_PARTY_B_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
