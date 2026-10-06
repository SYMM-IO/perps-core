// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title LiquidationOvershootStorage
/// @notice Per-PartyB close-to-liquidation overshoot configuration.
library LiquidationOvershootStorage {
	bytes32 internal constant LIQUIDATION_OVERSHOOT_STORAGE_SLOT = keccak256("diamond.standard.storage.liquidationovershoot");

	struct Layout {
		/// @notice Overshoot rate in 1e18 precision, keyed by PartyB and symbol.
		/// @dev Symbol 0 stores the PartyB default.
		mapping(address => mapping(uint256 => uint256)) rates;
		/// @notice Whether a nonzero symbol has an explicit override, including an override of zero.
		mapping(address => mapping(uint256 => bool)) hasOverride;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = LIQUIDATION_OVERSHOOT_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
