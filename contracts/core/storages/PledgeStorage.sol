// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Status of a PartyB pledge withdrawal request
/// @dev Pledge is PartyB's skin-in-the-game. Withdrawing requires approval.
///      NONE = no pending request
///      PENDING = waiting for admin approval
enum PledgeWithdrawStatus {
	NONE,
	PENDING
}

/// @notice Request to withdraw PartyB pledge
/// @dev PartyBs deposit pledge as a trust signal. Withdrawing is a multi-step
///      process requiring admin approval to prevent sudden rug-pulls.
struct PledgeWithdrawalRequest {
	address token;
	uint256 amount;
	address recipient;
	address requester;
	PledgeWithdrawStatus status;
}

/// @title PledgeStorage
/// @notice PartyB pledge deposits and withdrawal requests
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library PledgeStorage {
	bytes32 internal constant PLEDGE_STORAGE_SLOT = keccak256("diamond.standard.storage.pledge");

	struct Layout {
		/// @notice PartyB's pledge deposits by token
		/// @dev Extra collateral PartyBs deposit as trust signal. Not used for trading,
		///      just shows skin in the game. Maps partyB => token => amount.
		///      Will be slashed if PartyB misuses ADL or other actions.
		///      Note: stored in token decimals, not normalized to 18.
		mapping(address => mapping(address => uint256)) pledgeDeposit;
		/// @notice Pending pledge withdrawal requests
		/// @dev PartyBs must request and get approval before withdrawing pledge.
		///      Prevents sudden removal of trust collateral.
		mapping(address => PledgeWithdrawalRequest) pledgeWithdrawalRequests;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = PLEDGE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
