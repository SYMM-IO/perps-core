// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Fee } from "./QuoteStorage.sol";

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
		/// @notice Stops cross protocol balance transfers when true
		/// @dev External transfers move funds between different protocols via
		///      relayer contracts. Pause this if the relayers are compromised.
		bool externalTransferPaused;
		/// @notice Trading fee configuration per affiliate and symbol
		/// @dev Maps affiliate => symbolId => Fee struct (openFee, closeFee, isSet).
		///      If isSet is false, falls back to symbol's default fee. Enables affiliates
		///      to offer custom fee tiers to their users.
		mapping(address => mapping(uint256 => Fee)) affiliateFee;
		/// @notice Stops instant layer operations when true
		/// @dev The instant layer enables fast trading for PartyAs. When paused,
		///      instant actions revert but normal trading continues.
		bool instantLayerPaused;
		/// @notice Master switch for cross (master account) mode
		/// @dev When false, PartyBs cannot activate cross mode. This is the global
		///      gate - individual PartyBs still need to activate separately.
		///      Once activated, turning this off doesn't affect existing
		///      cross PartyBs.
		bool crossEnabled;
		/// @notice Whitelist of addresses that can act as virtual deposit/withdrawal providers
		/// @dev Virtual providers handle cross-chain deposits and withdrawals. They're trusted
		///      to credit user balances when funds are received on other chains.
		mapping(address => bool) virtualProviders;
		/// @notice Whitelist of addresses that can act as express withdrawal providers
		/// @dev Express providers front withdrawal funds to users immediately, then reclaim
		///      from Symmio after cooldown. They charge fees for this service. Must be
		///      registered here before they can accept withdrawal requests.
		mapping(address => bool) expressProviders;
		/// @notice Disables the legacy withdrawal path when true
		/// @dev The old withdrawal system is being phased out in favor of the new multi-part
		///      withdrawal system. Set this true once all users have migrated.
		bool deprecateOldWithdrawalPaused;
		/// @notice Floor for affiliate trading fees (in 18 decimals)
		/// @dev Prevents affiliates from setting fees below this threshold. Ensures minimum
		///      protocol revenue. Set as a percentage (e.g., 1e16 = 1%). Checked when
		///      affiliates configure their fee structure.
		uint256 minAffiliateFee;
		/// @notice Custom fee overrides per affiliate, per user, per symbol
		/// @dev Maps affiliate => user => symbolId => Fee. Enables VIP tiers or promotional
		///      rates for specific users. Takes precedence over affiliateFee when set.
		mapping(address => mapping(address => mapping(uint256 => Fee))) customAffiliateFee;
		/// @notice Who can grant/revoke each role
		/// @dev Maps role hash => admin address => is_admin. Role admins can modify hasRole
		///      for their role.
		mapping(bytes32 => mapping(address => bool)) roleAdmins;
		/// @notice Flag to disable the old per-quote funding iteration system
		/// @dev The old system required iterating through quotes to charge funding. When true,
		///      the new accumulative funding system is used exclusively. Set true once all
		///      solvers have migrated to the new system.
		bool iterativeFundingDeprecationFlag;
		/// @notice Enables the new accumulative funding rate system
		/// @dev The new system tracks weighted average funding rates at the symbol level.
		///      Both this and iterativeFundingDeprecationFlag control the funding transition.
		bool accumulativeFundingRateActivationFlag;
		/// @notice Stops PartyBs from opening new positions when true
		/// @dev PartyBs can still fill close requests and manage existing positions, but
		///      cannot lock or open new quotes. Useful during maintenance or when restricting
		///      new position creation while winding down.
		bool partyBOpenPositionsPaused;
		/// @notice Disables the legacy deallocate function when true
		/// @dev The old version signature was not unique and therefore muon had no control over it.
		bool legacyDeallocateDisabled;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = GLOBAL_APP_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
