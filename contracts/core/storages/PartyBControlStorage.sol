// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Status of a PartyB assurance collateral withdrawal request
/// @dev Assurance collateral is PartyB's skin-in-the-game. Withdrawing requires approval.
///      NONE = no pending request
///      PENDING = waiting for admin approval
///      APPROVED = can execute withdrawal
enum AssuranceWithdrawStatus {
	NONE,
	PENDING,
	APPROVED
}

/// @notice Request to withdraw PartyB assurance collateral
/// @dev PartyBs deposit assurance collateral as a trust signal. Withdrawing is a multi-step
///      process requiring admin approval to prevent sudden rug-pulls.
struct AssuranceWithdrawalRequest {
	address token;
	uint256 amount;
	address recipient;
	address requester;
	AssuranceWithdrawStatus status;
}

/// @title PartyBControlStorage
/// @notice PartyB configuration and risk management
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
		/// @notice PartyB's assurance collateral deposits by token
		/// @dev Extra collateral PartyBs deposit as trust signal. Not used for trading,
		///      just shows skin in the game. Maps partyB => token => amount.
		///      Will be slashed if PartyB misuses ADL or other actions.
		///      Note: stored in token decimals, not normalized to 18.
		mapping(address => mapping(address => uint256)) assuranceCollateral;
		/// @notice Pending assurance collateral withdrawal requests
		/// @dev PartyBs must request and get approval before withdrawing assurance collateral.
		///      Prevents sudden removal of trust collateral.
		mapping(address => AssuranceWithdrawalRequest) assuranceWithdrawalRequests;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = PARTY_B_CONTROL_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
