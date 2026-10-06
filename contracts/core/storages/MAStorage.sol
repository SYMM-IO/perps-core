// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Display and branding metadata for protocol entities (PartyBs, affiliates)
/// @dev Stored on-chain for discoverability. Frontend UIs can read this to display
///      hedger/affiliate information without needing off-chain databases.
struct EntityMetadata {
	string name;
	string brandColor;
	string metadata;
}

/// @title MAStorage - Master Agreement Storage
/// @notice Protocol parameters and configuration for trading rules and timing
/// @dev These are the "knobs" that control protocol behavior: cooldowns, fees, limits.
///      Most values are set by admins and affect all users. Change with extreme care -
///      wrong values can break liquidations, enable exploits, or lock user funds.
library MAStorage {
	bytes32 internal constant MA_STORAGE_SLOT = keccak256("diamond.standard.storage.masteragreement");

	struct Layout {
		/// @notice How long users must wait after deallocating before they can withdraw
		/// @dev This cooldown exists for off-chain monitoring to detect suspicious activity.
		///      Typically 12 hours. Previously named deallocateCooldown.
		uint256 withdrawCooldownPeriod;
		/// @notice How long PartyA must wait before force-canceling a pending quote
		/// @dev Gives PartyB time to respond to a quote cancel request before PartyA can unilaterally cancel.
		uint256 forceCancelCooldown;
		/// @notice How long PartyA must wait before force-canceling a close request
		/// @dev Same concept as forceCancelCooldown but for close requests instead of quotes.
		uint256 forceCancelCloseCooldown;
		/// @notice Minimum time after close request before force close price window can start
		/// @dev The HighLowPriceSig's startTime must be >= quote.statusModifyTimestamp + forceCloseFirstCooldown.
		///      Ensures PartyB has enough time to consider and respond to the close request
		///      before PartyA can use price data for force close.
		uint256 forceCloseFirstCooldown;
		/// @notice Maximum age of price signatures used during PartyB liquidation
		/// @dev Price signature timestamp must be <= partyBLiquidationTimestamp + liquidationTimeout.
		///      Ensures prices used to close positions during liquidation are timely and
		///      relevant to when the liquidation was initiated.
		uint256 liquidationTimeout;
		/// @notice Percentage of remaining LF for the initiating liquidator in PartyB liquidation (18 decimals)
		/// @dev When liquidatePartyB is called, if LF exceeds the deficit:
		///      remainingLf = partyBLockedBalances.lf - deficit
		///      initiatorShare = remainingLf * liquidatorShare / 1e18 → goes to liquidatePartyB caller
		///      The rest is divided per-position via partyBPositionLiquidatorsShare for position liquidators.
		uint256 liquidatorShare;
		/// @notice Maximum number of pending quotes a PartyA can have at once
		/// @dev Prevents spam and limits exposure calculation complexity. If a user hits
		///      this limit, they must wait for existing quotes to resolve before sending more.
		uint256 pendingQuotesValidLength;
		/// @notice DEPRECATED - Previously set force close gap ratio globally
		/// @dev Now handled per-symbol via SymbolStorage.forceCloseGapRatio. Kept for
		///      storage layout compatibility. Do not use.
		uint256 deprecatedForceCloseGapRatio;
		/// @notice Whether an address is registered as a PartyB (market maker)
		/// @dev Only registered PartyBs can lock and open positions. This is the whitelist.
		///      Removing a PartyB doesn't close their positions - they just can't open new ones.
		mapping(address => bool) partyBStatus;
		/// @notice Whether an address can perform liquidations
		/// @dev Liquidator whitelist. Prevents random addresses from griefing liquidations.
		///      In practice, often set to specific keeper bots.
		mapping(address => bool) liquidationStatus;
		/// @notice Whether a specific PartyB-PartyA pair is being liquidated
		/// @dev Maps partyB => partyA => isLiquidating. Prevents actions on positions
		///      while liquidation is in progress.
		mapping(address => mapping(address => bool)) partyBLiquidationStatus;
		/// @notice When liquidation started for a PartyB-PartyA pair
		/// @dev Maps partyB => partyA => timestamp. Used for timeout calculations
		///      and dispute windows.
		mapping(address => mapping(address => uint256)) partyBLiquidationTimestamp;
		/// @notice Per-position LF share for liquidators closing positions in PartyB liquidation
		/// @dev Calculated during liquidatePartyB: (remainingLf - initiatorShare) / positionsCount.
		///      Maps partyB => partyA => sharePerPosition. Liquidators calling liquidatePositionsPartyB
		///      receive this amount multiplied by the number of positions they close.
		mapping(address => mapping(address => uint256)) partyBPositionLiquidatorsShare;
		/// @notice Array of all registered PartyB addresses
		/// @dev Used for iteration (e.g., listing all hedgers in a view function).
		///      Kept in sync with partyBStatus mapping - when registering/unregistering,
		///      both are updated.
		address[] partyBList;
		/// @notice Required time gap between price window end and force close execution
		/// @dev The HighLowPriceSig's endTime must be <= block.timestamp - forceCloseSecondCooldown,
		///      AND endTime + forceCloseSecondCooldown <= quote.deadline. Ensures PartyB had
		///      sufficient time after the price window to fill the close request normally.
		uint256 forceCloseSecondCooldown;
		/// @notice Price penalty applied during force close (18 decimals, e.g., 1e16 = 1%)
		/// @dev For LONG: closePrice = max(requestedPrice + penalty, averagePrice).
		///      For SHORT: closePrice = min(requestedPrice - penalty, averagePrice).
		///      PartyB gets a worse price as penalty for not responding to close requests.
		uint256 forceClosePricePenalty;
		/// @notice Minimum price window duration when average price is used in force close
		/// @dev When force close uses the averagePrice (to protect against extreme moves),
		///      the window (endTime - startTime) must exceed this value. Ensures price
		///      averaging covers a meaningful time period to prevent manipulation.
		uint256 forceCloseMinSigPeriod;
		/// @notice Minimum time between consecutive deallocate operations
		/// @dev Different from deallocateCooldown - this is debounce between deallocates,
		///      not between deallocate and withdraw. Prevents rapid-fire deallocations.
		uint256 deallocateDebounceTime;
		/// @notice Whether an address is a registered affiliate
		/// @dev Affiliates can set custom fees and receive fee revenue. Must be registered
		///      here before their affiliate address can be used in quotes.
		mapping(address => bool) affiliateStatus;
		/// @notice Minimum time between UPNL settlements by the same third-party signer
		/// @dev Only enforced when: (1) not a force close operation, AND (2) signer != partyB.
		///      PartyB settling their own positions and force close operations bypass this.
		///      Prevents third parties from spamming settlements on the same partyB-partyA pair.
		uint256 settlementCooldown;
		/// @notice Timestamp of last UPNL settlement by each third-party signer
		/// @dev Maps signer => partyB => partyA => timestamp. Only updated/checked when
		///      signer != partyB and not force close. Used with settlementCooldown to
		///      rate-limit third-party settlement calls.
		mapping(address => mapping(address => mapping(address => uint256))) lastUpnlSettlementTimestamp;
		/// @notice Address that receives excess liquidation fees above the profit cap
		/// @dev During PartyA liquidation, if remainingLf > maxLiquidationProfitPerPosition * positionsCount,
		///      the excess goes here. Funds accumulate in this address's balance for later manual redistribution by the address owner.
		address liquidationInsuranceVault;
		/// @notice Cap on profit a liquidator can make from a single position
		/// @dev Prevents excessive liquidator profits on large positions. Excess goes
		///      to insurance vault.
		uint256 maxLiquidationProfitPerPosition;
		/// @notice Display metadata for registered entities
		/// @dev Maps entity address => metadata. Used by frontends to show hedger
		///      and affiliate branding information.
		mapping(address => EntityMetadata) entitiesMetadata;
		/// @notice Maximum number of PartyBs a PartyA can have open positions with
		/// @dev When checking if a symbol is allowed for PartyA, we loop through all connected
		///      PartyBs to verify none have blacklisted it. This limit bounds that loop's gas cost.
		///      If at limit, must close positions with one PartyB before opening with another.
		uint256 maxPartyAConnectionLimit;
		/// @notice Whether a PartyB can use auto-deleveraging to close positions unilaterally
		/// @dev When enabled, PartyB can call adlClose() to close positions at a specified price
		///      without PartyA consent. Used for risk management. Enabled by PARTY_B_MANAGER_ROLE.
		mapping(address => bool) adlEnabled;
		/// @notice Timestamp of last liquidator action for a PartyA
		/// @dev Updated on every liquidation step (setSymbolsPrice, liquidatePositions, etc.)
		///      Can be used later to enforce timeouts if liquidators become inactive.
		mapping(address => uint256) partyALiquidatorLastActionTimestamp;
		/// @notice Whether a PartyB is operating in cross (master account) mode
		/// @dev Cross-margin PartyBs have one shared balance across all PartyAs instead of
		///      isolated per-PartyA allocations. When true, uses address(0) for allocation
		///      mappings and has different liquidation flow via ClearingHouse.
		mapping(address => bool) crossModeEnabledForPartyB;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = MA_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
