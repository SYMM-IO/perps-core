// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice The three states of PartyA-PartyB binding
/// @dev Binding is required for instant actions mode.
///      NOT_BOUND = can trade with any PartyB
///      BOUND = locked to one PartyB (required for instant actions)
///      PENDING_UNBIND = waiting for unbind cooldown to complete
enum BindStatus {
	NOT_BOUND,
	BOUND,
	PENDING_UNBIND
}

/// @notice PartyA's binding state to a specific PartyB for instant and oracle-less trading
/// @dev Binding is required for instant actions mode. Once bound, PartyA can only trade
///      with their bound PartyB. modifyTimestamp tracks when binding changed for cooldown.
struct BindState {
	BindStatus status;
	address partyB;
	uint256 modifyTimestamp;
}

/// @title TradingModeStorage
/// @notice PartyA binding and instant layer features
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
library TradingModeStorage {
	bytes32 internal constant TRADING_MODE_STORAGE_SLOT = keccak256("diamond.standard.storage.tradingmode");

	struct Layout {
		/// @notice PartyA's binding state to a specific PartyB
		/// @dev Enables oracle-less trading. Required for instant actions. When bound,
		///      PartyA can only trade with their bound PartyB.
		///      Contains status (NOT_BOUND/BOUND/PENDING_UNBIND), the partyB
		///      address, and timestamp for unbind cooldown tracking.
		mapping(address => BindState) bindState;
		/// @notice Whether PartyB is allowed to be bound to PartyAs
		/// @dev If false, PartyAs cannot bind to this PartyB. Not every solver is allowed to
		///      have oracle-less trading.
		mapping(address => bool) isPartyBBindable;
		/// @notice Whether PartyA has instant actions mode enabled
		/// @dev Instant mode allows solver to be sure that partyA is not going to do any on-chain actions.
		///      Requires PartyA to be bound to a specific PartyB first.
		mapping(address => bool) instantActionsMode;
		/// @notice When PartyA's instant actions mode deactivation can be finalized
		/// @dev Deactivating instant mode is a two-step process: request deactivation, wait
		///      for cooldown, then finalize. This stores when the cooldown ends.
		mapping(address => uint256) instantActionsModeDeactivateTime;
		/// @notice How long to wait before instant actions mode deactivation completes
		/// @dev Prevents instant on/off toggling that could be used to game the solvers.
		uint256 deactiveInstantActionModeCooldown;
		/// @notice How long PartyA must wait to complete unbinding from PartyB
		/// @dev Unbinding is a two-step process: request, wait cooldown, complete.
		///      Prevents instant unbinding that could be used to dodge obligations.
		uint256 unbindCooldown;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = TRADING_MODE_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
