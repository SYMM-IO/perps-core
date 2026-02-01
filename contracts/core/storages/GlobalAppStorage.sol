// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title GlobalAppStorage
/// @notice Central configuration and pause state for the entire Symmio protocol
/// @dev Uses diamond storage pattern with a unique slot to avoid collisions.
///      Most variables here are checked in modifiers across all facets.
library GlobalAppStorage {
	bytes32 internal constant GLOBAL_APP_STORAGE_SLOT = keccak256("diamond.standard.storage.global");

	struct Layout {
		/// @notice The ERC20 token used as collateral for all trading (e.g., USDC)
		/// @dev Can be changed by admin via setCollateral(), but only when the contract holds
		///      zero balance of the current collateral. All balances, locked values, and
		///      settlements are denominated in this token. Changing while funds exist would
		///      break accounting entirely.
		address collateral;
		/// @notice Where trading fees go in case of no affiliate or affiliate has no custom fee collector
		address defaultFeeCollector;
		/// @notice The big red button - stops everything when true
		/// @dev Checked first in every pausable operation via the Pausable modifier hierarchy.
		///      When this is on, nothing works: no deposits, no trading, no withdrawals,
		///      no liquidations. Only use in emergencies. All other pause flags are also
		///      checked against this - if globalPaused is true, nothing runs regardless of
		///      other pause states.
		bool globalPaused;
		/// @notice Stops all liquidation processing when true
		/// @dev Use this when liquidation logic has a bug or oracle issues would cause
		///      unfair liquidations. Positions can still be opened/closed, just not liquidated.
		bool liquidationPaused;
		/// @notice Stops balance-changing operations when true
		/// @dev Blocks deposits, withdrawals, allocations, and deallocations. Trading can
		///      continue with existing allocated funds. Useful when
		///      investigating suspicious balance activity.
		bool accountingPaused;
		/// @notice Stops all PartyB operations when true
		/// @dev PartyBs cannot lock quotes, open positions, or fill close requests.
		///      PartyA can still send quotes, but they'll sit pending.
		bool partyBActionsPaused;
		/// @notice Stops all PartyA (trader) operations when true
		/// @dev Users cannot send quotes, request closes, or cancel. PartyBs can still
		///      process existing requests. Rarely used - typically you'd pause specific
		///      users via suspendedAddresses instead.
		bool partyAActionsPaused;
		/// @notice Activates emergency mode for the entire protocol
		/// @dev When true, RESTRICTS normal PartyB operations (position opens, batch actions)
		///      and ENABLES emergency close positions.
		bool emergencyMode;
		/// @notice Limit checked when users allocate funds for trading
		/// @dev Only enforced at allocation time via allocate() and internalTransfer().
		///      NOT a hard cap - users can exceed this through trading profits or if
		///      the limit is lowered after they already allocated. Used for gradual
		///      rollouts or regulatory compliance.
		uint256 balanceLimitPerUser;
		/// @notice Tracks which PartyBs are in emergency mode
		/// @dev When true for a PartyB, enables emergencyClosePosition for quotes with that
		///      PartyB INDEPENDENTLY of global emergencyMode. Allows surgical wind-down of
		///      specific PartyBs without affecting the rest of the protocol.
		mapping(address => bool) partyBEmergencyStatus;
		/// @notice Role-based access control: who can do what
		/// @dev Maps user address => role hash => has_role. Roles are keccak256 hashes of
		///      role names (e.g., keccak256("SETTER_ROLE")). Checked via LibAccessibility.hasRole()
		///      in the onlyRole modifier.
		mapping(address => mapping(bytes32 => bool)) hasRole;
		/// @notice Stops internal balance transfers between accounts when true
		/// @dev Internal transfers let users move funds between their own accounts on the
		///      same diamond without withdrawal cooldown. Pause this if you suspect abuse
		///      or need to freeze fund movements during an investigation.
		bool internalTransferPaused;
		/// @notice Custom fee collector address per affiliate
		/// @dev Maps affiliate address => their fee collector. If not set (zero address),
		///      falls back to defaultFeeCollector.
		mapping(address => address) affiliateFeeCollector;
		/// @notice External contract that validates Muon signatures
		/// @dev Decoupled from main contract to support multiple signers and key rotation.
		///      All Muon signature checks go through this contract. If this is wrong or
		///      compromised, signature verification breaks entirely.
		address signatureVerifier;
		/// @notice Who can grant/revoke each role
		/// @dev Maps role hash => admin address => is_admin. Role admins can modify hasRole
		///      for their role.
		mapping(bytes32 => mapping(address => bool)) roleAdmins;
		/// @notice Stops PartyBs from opening new positions when true
		/// @dev PartyBs can still fill close requests and manage existing positions, but
		///      cannot lock or open new quotes. Useful during maintenance or when restricting
		///      new position creation while winding down.
		bool partyBOpenPositionsPaused;
		/// @notice Disables the legacy deallocate function when true
		/// @dev The old version signature was not unique and therefore muon had no control over it.
		bool legacyDeallocateDeprecated;
		/// @notice Address that receives excess liquidation fees above the profit cap
		/// @dev During PartyA liquidation, if remainingLf > maxLiquidationProfitPerPosition * positionsCount,
		///      the excess goes here. Also receives soft liquidation penalties from cross PartyBs.
		///      These funds are used to cover deficits later in overdue liquidations.
		address softLiquidationPenaltyCollector;
		/// @notice Current signer for meta-transaction/proxy pattern
		/// @dev When a proxy calls on behalf of a user, this is set to the actual user.
		///      LibSigner.getSigner() returns this if set, otherwise msg.sender.
		///      Used to support gasless transactions and account abstraction.
		address signer;
		/// @notice Stops instant layer operations when true
		/// @dev The instant layer enables fast trading for PartyAs. When paused,
		///      instant actions revert but normal trading continues.
		bool instantLayerPaused;
		/// @notice Flag indicating calls should be treated as instant layer operations
		/// @dev Set via setCallFromInstantLayer() by authorized callers. This is a persistent
		///      state flag, not automatically reset - the caller must manage its lifecycle.
		///      When true, instant actions mode checks pass for bound PartyAs. Checked in
		///      Accessibility modifiers to allow/restrict certain operations.
		bool callFromInstantLayer;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = GLOBAL_APP_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
