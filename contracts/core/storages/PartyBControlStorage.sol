// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title PartyBControlStorage
/// @notice PartyB symbol control configuration
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library PartyBControlStorage {
	bytes32 internal constant PARTY_B_CONTROL_STORAGE_SLOT = keccak256("diamond.standard.storage.partybcontrol");

	struct Layout {
		/// @notice Symbol types a PartyB allows itself to trade
		/// @dev Set BY PartyB to control their own exposure. Maps partyB => symbolType => allowed.
		///      Not whitelisted = effectively blacklisted (same effect).
		///      Example: a PartyB may only whitelist crypto (type 1), blocking stocks (type 3).
		mapping(address => mapping(uint256 => bool)) partyBWhitelistedSymbolTypes;
		/// @notice Specific symbols a PartyB allows itself to trade
		/// @dev Set BY PartyB for granular control. Maps partyB => symbolId => allowed.
		///      Not whitelisted = effectively blacklisted (same effect).
		mapping(address => mapping(uint256 => bool)) partyBWhitelistedSymbols;
		/// @notice Specific symbols a PartyB has explicitly blocked
		/// @dev Set BY PartyB. If a PartyB blacklists a symbol, any PartyA connected to them
		///      cannot open trades on that symbol even with OTHER PartyBs.
		mapping(address => mapping(uint256 => bool)) partyBBlacklistedSymbols;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = PARTY_B_CONTROL_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
