// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LockedValues } from "../storages/QuoteStorage.sol";

/// @notice Classification of liquidation severity based on timing and deficit
/// @dev Determines how remaining funds are distributed and who pays what.
///      NONE = not liquidated
///      NORMAL = liquidated on time (no deficit)
///      LATE = liquidated with small deficit (more than LF but less than LF + CVA)
///      OVERDUE = liquidated with large deficit (more than LF + CVA)
enum LiquidationType {
	NONE,
	NORMAL,
	LATE,
	OVERDUE
}

/// @notice Settlement state for allocated balance transfers during force close
/// @dev Used in force close flow to track if allocated balance from cross-mode
///      PartyB needs to be gathered before closing.
enum AllocatedSettlementState {
	NONE,
	GATHER_ALLOCATED_CROSS
}

/// @notice Settlement state for unrealized PnL during force close
/// @dev Tracks whether UPNL has been realized as part of force close workflow.
///      NONE = not settled
///      REALIZED = settled in isolated mode
///      REALIZED_CROSS = settled in cross-margin mode
enum UPNLSettlementState {
	NONE,
	REALIZED,
	REALIZED_CROSS
}

/// @notice PartyB's solvency state during a force close operation
/// @dev Determines what happens after force close completes.
///      NONE = not in force close
///      INSOLVENT = PartyB became insolvent during close
///      SOLVENT = PartyB remained solvent
///      LIQUIDATED = PartyB was liquidated
enum PartyBForceCloseState {
	NONE,
	INSOLVENT,
	SOLVENT,
	LIQUIDATED
}

/// @notice Tracks UPNL settlement progress between PartyA and PartyB
/// @dev Used to reconcile unrealized PnL before force close or liquidation.
///      actualAmount = what's been settled so far, expectedAmount = total to settle,
///      cva = Credit Valuation Adjustment held, pending = settlement in progress.
struct SettlementState {
	int256 actualAmount;
	int256 expectedAmount;
	uint256 cva;
	bool pending;
}

/// @notice Complete state tracking for a force close operation on a position
/// @dev Force close is a multi-step process that lets PartyA close positions when PartyB
///      isn't responding. This struct tracks every stage: price signature used, settlement
///      states, and PartyB's resulting solvency. Note: inProgress is set during init but
///      does NOT prevent re-initialization - it only gates progression to subsequent steps.
///      The quote's status (CLOSE_PENDING) is the primary guard against invalid force closes.
struct ForceCloseDetail {
	bytes priceSigId;
	uint256 quoteId;
	uint256 timestamp;
	int256 partyBAvailableAfterClose;
	uint256 closePrice;
	int256 upnlPartyB;
	uint256 currentPrice;
	UPNLSettlementState settlementState;
	AllocatedSettlementState allocatedSettlementState;
	PartyBForceCloseState partyBState;
	bool inProgress;
}

/// @notice Complete liquidation state for a PartyA being liquidated
/// @dev This is the source of truth during PartyA liquidation. Contains everything needed
///      to process the liquidation: UPNL at time of insolvency, total unrealized losses,
///      any deficit that PartyB must cover, and the liquidator's fee. The disputed flag
///      allows challenging incorrect liquidations. involvedPartyBCounts tracks how many
///      hedgers have positions being liquidated.
struct LiquidationDetail {
	bytes liquidationId;
	LiquidationType liquidationType;
	int256 upnl;
	int256 totalUnrealizedLoss;
	uint256 deficit;
	uint256 liquidationFee;
	uint256 timestamp;
	uint256 involvedPartyBCounts;
	int256 partyAAccumulatedUpnl;
	bool disputed;
	uint256 liquidationTimestamp;
}

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

/// @notice PartyA's binding state to a specific PartyB for instant and oracle-less trading
/// @dev Binding is required for instant actions mode. Once bound, PartyA can only trade
///      with their bound PartyB. modifyTimestamp tracks when binding changed for cooldown.
struct BindState {
	BindStatus status;
	address partyB;
	uint256 modifyTimestamp;
}

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

/// @notice A price snapshot at a specific time
/// @dev Used during liquidation to record prices at the moment of insolvency.
///      The timestamp ensures prices are fresh and match the liquidation event.
struct Price {
	uint256 price;
	uint256 timestamp;
}

/// @notice Status of a cross-diamond external transfer
/// @dev Tracks the lifecycle of external transfers between Symmio diamonds.
///      PENDING = initiated but not yet completed/canceled by provider
///      COMPLETED = provider accepted and deposited on target
///      CANCELED = user canceled
enum ExternalTransferStatus {
	PENDING,
	COMPLETED,
	CANCELED
}

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

/// @notice Transfer request moving funds between Symmio deployments or to other trusted protocols
/// @dev Enables fund movement between different diamonds (e.g., perps and options).
///      Uses virtual providers as intermediaries who deposit on the target diamond.
///      The provider must accept the transfer, or user can cancel after timeout.
struct ExternalTransferReq {
	uint256 id;
	address sender; // user1 in source contract
	address receiver; // user2 in target contract
	address source;
	address target;
	uint256 amount;
	uint256 timestamp;
	address provider; // virtual provider who handles the transfer
	ExternalTransferStatus status;
}

/// @title AccountStorage
/// @notice All account balance and state data for PartyAs and PartyBs
/// @dev The heart of the accounting system. Every balance, locked amount, and account state
///      lives here.
library AccountStorage {
	bytes32 internal constant ACCOUNT_STORAGE_SLOT = keccak256("diamond.standard.storage.account");

	struct Layout {
		/// @notice Withdrawable balance per user (not yet committed to trading)
		/// @dev Users can withdraw from this (after cooldown) or allocate it for trading.
		///      Updated by: deposit, withdraw, deallocate, internal/external transfers.
		mapping(address => uint256) balances;
		/// @notice Funds committed to trading but not yet locked in positions
		/// @dev When PartyA allocates, funds move here. This is their "margin account".
		///      Can be used to open positions or deallocated back to balance.
		mapping(address => uint256) allocatedBalances;
		/// @notice Margin locked when a quote is sent but not yet opened
		/// @dev When PartyA sends a quote, required margin (CVA + LF + partyAmm) moves here.
		///      If PartyB opens the position, it moves to lockedBalances. If canceled, refunded.
		///      Contains CVA (credit valuation adjustment), LF (liquidation fee), partyAmm
		///      (PartyA maintenance margin).
		mapping(address => LockedValues) pendingLockedBalances;
		/// @notice Margin locked in open positions
		/// @dev Once a quote is opened, locked values move from pending to here. Released when
		///      position closes.
		mapping(address => LockedValues) lockedBalances;
		/// @notice PartyB's allocated balance per PartyA
		/// @dev In isolated mode, PartyB allocates separately for each PartyA they trade with.
		///      Maps partyB => partyA => amount. For cross-mode PartyB, address(0) is used
		///      as the master bucket instead of per-partyA allocations.
		mapping(address => mapping(address => uint256)) partyBAllocatedBalances;
		/// @notice PartyB's pending locked values per PartyA
		/// @dev Same as pendingLockedBalances but for the PartyB side of each trade.
		///      Tracks how much PartyB has committed to quotes not yet opened.
		mapping(address => mapping(address => LockedValues)) partyBPendingLockedBalances;
		/// @notice PartyB's locked values in open positions per PartyA
		/// @dev Same as lockedBalances but for the PartyB side.
		mapping(address => mapping(address => LockedValues)) partyBLockedBalances;
		/// @notice Timestamp of last deallocate action per user
		/// @dev Despite the name, this tracks deallocate time, not withdraw time. Checked
		///      against deallocateCooldown before allowing withdrawals.
		mapping(address => uint256) withdrawCooldown;
		/// @notice Replay protection counter for PartyA signatures
		/// @dev Incremented with each action that changes the UPNL of partyA.
		///      Muon signatures include this nonce to prevent replay attacks.
		mapping(address => uint256) partyANonces;
		/// @notice Replay protection counter for PartyB signatures per PartyA
		/// @dev PartyB has separate nonces for each PartyA they trade with. Both
		///      per-PartyA nonces AND the address(0) global nonce are always incremented
		///      on every upnl changing operation. This nonce will be ignored for cross partyBs
		///      when doing all operations except deallocation. The reason for that is to allow
		///      parallel operations to solver.
		mapping(address => mapping(address => uint256)) partyBNonces;
		/// @notice Accounts frozen by admin due to suspicious activity
		/// @dev Suspended users cannot open/close positions or have positions opened against them.
		///      Checked via notSuspended modifier. Used when investigating potential exploits
		///      or rule violations. Withdrawal requests have separate suspension handling.
		mapping(address => bool) suspendedAddresses;
		/// @notice Full liquidation state for PartyAs being liquidated
		/// @dev Contains everything about an ongoing liquidation: UPNL, deficit, type, timestamp, etc.
		mapping(address => LiquidationDetail) liquidationDetails;
		/// @notice Oracle prices set during liquidation per symbol
		/// @dev When liquidating, we lock in prices for each symbol at the moment of
		///      insolvency. Maps user => symbolId => Price. Used to close positions at
		///      consistent prices throughout the liquidation process.
		mapping(address => mapping(uint256 => Price)) symbolsPrices;
		/// @notice Addresses participating in a user's liquidation
		/// @dev Multiple liquidators can process a single liquidation. Each gets a share
		///      of the liquidation fee proportional to their contribution. Cleared after
		///      liquidation completes.
		mapping(address => address[]) liquidators;
		/// @notice Reimbursement owed to PartyA from pending fees or new allocations during deferred liquidations
		/// @dev This will be paid back to user at the end of liquidation process.
		mapping(address => uint256) partyAReimbursement;
		/// @notice UPNL settlement state between PartyA-PartyB pairs during liquidation
		/// @dev Used during PartyA liquidation to track UPNL reconciliation with each PartyB.
		///      expectedAmount = full PnL for PartyA's accumulated UPNL tracking
		///      actualAmount = amount actually transferred (may differ in OVERDUE due to deficit,
		///                     or overridden via resolveLiquidationDispute)
		///      cva = CVA held for this PartyB, pending = settlement in progress.
		///      Cleared after liquidation completes via settlePartyALiquidation.
		mapping(address => mapping(address => SettlementState)) settlementStates;
		/// @notice PartyB's reserve funds for covering force close scenarios
		/// @dev Extra collateral PartyB deposits as a safety buffer. Used during force close
		///      if their allocated balance is insufficient. Not used in cross mode.
		mapping(address => uint256) reserveVault;
		/// @notice PartyA's binding state to a specific PartyB
		/// @dev Enables oracle-less trading. Required for instant actions. When bound,
		///      PartyA can only trade with their bound PartyB.
		///      Contains status (NOT_BOUND/BOUND/PENDING_UNBIND), the partyB
		///      address, and timestamp for unbind cooldown tracking.
		mapping(address => BindState) bindState;
		/// @notice Whether a PartyB is operating in cross (master account) mode
		/// @dev Cross-margin PartyBs have one shared balance across all PartyAs instead of
		///      isolated per-PartyA allocations. When true, uses address(0) for allocation
		///      mappings and has different liquidation flow via ClearingHouse.
		mapping(address => bool) isCrossPartyB;
		/// @notice Liquidation state for cross PartyBs
		/// @dev Similar to liquidationDetails but for cross-mode PartyB liquidation.
		mapping(address => CrossLiquidationDetail) crossLiquidationDetails;
		/// @notice Relayer contracts authorized for external transfers to specific targets
		/// @dev Maps target address => authorized relayer. The relayer receives
		///      funds and deposits them on the target for the user.
		mapping(address => address) externalTransferTargetsRelayers;
		/// @notice Hook contracts called on protocol events per affiliate
		/// @dev Called on onOpenPosition, onClosePosition, onCancelQuote events.
		///      address(0) key is the system-wide hook. Enables custom integrations.
		mapping(address => address) affiliateHooks;
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
		/// @notice List of PartyBs that PartyA has open positions with
		/// @dev Maintained for efficient iteration when calculating PartyA UPNL across
		///      all their hedgers. Added when first position opens, removed when last closes.
		mapping(address => address[]) connectedPartyBs;
		/// @notice Fast lookup for whether PartyA has positions with a specific PartyB
		/// @dev O(1) check instead of iterating connectedPartyBs array.
		mapping(address => mapping(address => bool)) isConnectedPartyB;
		/// @notice State of force close operations per quote
		/// @dev Force close lets PartyA close positions when PartyB isn't responding.
		///      Tracks the multi-step process: settlement state, allocated balance state,
		///      PartyB solvency result. The inProgress flag gates step progression but does
		///      NOT prevent re-initialization - quote status is the primary guard.
		mapping(uint256 => ForceCloseDetail) forceCloseDetails;
		/// @notice Counter for external transfer IDs
		/// @dev Auto-incremented when creating external transfers. Used as unique identifier
		///      for each external transfer request.
		uint256 lastExternalTransferId;
		/// @notice External transfer request data by ID
		/// @dev Stores the full transfer request: sender, receiver, source/target contracts,
		///      amount, provider, and status. Provider must accept or user can cancel.
		mapping(uint256 => ExternalTransferReq) externalTransfers;
		/// @notice Whether PartyB is allowed to be bound to PartyAs
		/// @dev If false, PartyAs cannot bind to this PartyB. Not every solver is allowed to
		///      have oracle-less trading.
		mapping(address => bool) isPartyBBindable;
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
		bytes32 slot = ACCOUNT_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
