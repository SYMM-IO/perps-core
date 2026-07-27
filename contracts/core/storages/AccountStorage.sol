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
///      LATE = liquidated with small deficit (at least LF but at most LF + CVA)
///      OVERDUE = liquidated with large deficit (more than LF + CVA)
enum LiquidationType {
	NONE,
	NORMAL,
	LATE,
	OVERDUE
}

/// @notice PartyB's solvency state during a force close operation
/// @dev Determines what happens after force close completes.
///      NONE = not in force close
///      CLOSED_INSOLVENT = (cross partyB mode) close succeeded but PartyB could not remain solvent when accounting for uPNL
///      CLOSED_SOLVENT = close succeeded without liquidation/insolvency
///      CLOSED_LIQUIDATED = (normal partyB mode) PartyB was liquidated during force close
///
///      Event mapping:
///      - Cross partyB mode: `ForceClosePosition(...)` is always emitted. If insolvent, `ForceClosePartyBInsolvent(...)` is also emitted.
///      - Normal partyB mode: `ForceClosePosition(...)` implies CLOSED_SOLVENT; `LiquidatePartyB(...)` implies CLOSED_LIQUIDATED.
enum PartyBForceCloseState {
	NONE,
	CLOSED_INSOLVENT,
	CLOSED_SOLVENT,
	CLOSED_LIQUIDATED
}

/// @notice Tracks PnL settlement between PartyA and PartyB during PartyA liquidation
/// @dev Used during PartyA liquidation to reconcile PnL with each PartyB.
///      expectedAmount = full PnL for PartyA's accumulated UPNL tracking
///      actualAmount = amount actually transferred to/from PartyB (may differ in OVERDUE due to deficit,
///                     or overridden via resolveLiquidationDispute)
///      cva = CVA returned to PartyB, pending = settlement in progress.
struct LiquidationSettlementState {
	int256 actualAmount;
	int256 expectedAmount;
	uint256 cva;
	bool pending;
}

/// @notice Complete state tracking for a force close operation on a position
/// @dev Force close is a multi-step process that lets PartyA close positions when PartyB
///      isn't responding. This struct tracks the workflow snapshot (uPNL/currentPrice),
///      the derived closePrice, and PartyB's resulting solvency. Note: inProgress is set during init but
///      does NOT prevent re-initialization - it only gates progression to subsequent steps.
///      The quote's status (CLOSE_PENDING) is the primary guard against invalid force closes.
struct ForceCloseDetail {
	/// @notice The latest Muon request id used to fill/refresh the force-close snapshot.
	/// @dev Observability-only metadata for off-chain correlation; NOT used in protocol logic.
	bytes priceSigId;
	/// @notice The quote id this struct corresponds to.
	/// @dev Redundant with the mapping key; kept for convenience in off-chain reads.
	uint256 quoteId;
	/// @notice Last time the workflow snapshot was updated (init/refresh/settle/finalize depending on flow).
	uint256 timestamp;
	/// @notice PartyB available balance after close (set on finalize).
	int256 partyBAvailableAfterClose;
	/// @notice The close price computed at initialization (kept stable across refreshes).
	uint256 closePrice;
	/// @notice Snapshot uPNL for PartyB used during finalize (can be refreshed/adjusted).
	int256 upnlPartyB;
	/// @notice Snapshot current price used during finalize (can be refreshed).
	uint256 currentPrice;
	/// @notice Final PartyB outcome for the force close workflow (set on finalize).
	PartyBForceCloseState partyBState;
	/// @notice Whether a 3-step force close workflow is active for this quoteId.
	bool inProgress;
	/// @notice Symbol price/quantity basis version when the close price was calculated.
	/// @dev Finalization rejects the workflow if a physical restatement advanced this version.
	uint256 basisVersion;
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
	/// @dev Sum of finalized per-PartyB expected settlement amounts; used to verify the signed PartyA uPNL.
	int256 partyAAccumulatedUpnl;
	bool disputed;
	uint256 liquidationTimestamp;
}

/// @notice A price snapshot at a specific time
/// @dev Used during liquidation to record prices at the moment of insolvency.
///      The timestamp ensures prices are fresh and match the liquidation event.
struct Price {
	uint256 price;
	uint256 timestamp;
}

/// @notice Price and funding snapshot committed by Muon for one PartyB-symbol pair during PartyA liquidation.
struct LiquidationPartyBSymbolSnapshot {
	bool isSet;
	uint256 price;
	int256 cumulativeLongFee;
	int256 cumulativeShortFee;
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
		/// @dev Records when a user last deallocated funds. Used with MAStorage.withdrawCooldownPeriod
		///      to enforce a cooldown before withdrawals are allowed.
		mapping(address => uint256) deallocateTimestamp;
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
		/// @dev [0] is the account that starts liquidation. [1], when present, is the first account
		///      that supplies the liquidation prices. The liquidation fee is split 50/50 when both
		///      are recorded; otherwise the starter receives the full fee. Cleared after settlement.
		mapping(address => address[]) liquidators;
		/// @notice Reimbursement owed to PartyA, used by clearing house takeover flow
		/// @dev In CH takeover: stores pending fees added by liquidatePendingPositionsForClearingHouse.
		///      CH can pull via deallocateForClearingHouse(REIMBURSEMENT_KEY). Released at settlePartyATakeover.
		mapping(address => uint256) partyAReimbursement;
		/// @notice UPNL settlement state between PartyA-PartyB pairs during liquidation
		/// @dev Used during PartyA liquidation to track UPNL reconciliation with each PartyB.
		///      expectedAmount = full PnL for PartyA's accumulated UPNL tracking
		///      actualAmount = amount actually transferred (may differ in OVERDUE due to deficit,
		///                     or overridden via resolveLiquidationDispute)
		///      cva = CVA held for this PartyB, pending = settlement in progress.
		///      Cleared after liquidation completes via settlePartyALiquidation.
		mapping(address => mapping(address => LiquidationSettlementState)) settlementStates;
		/// @notice PartyB's reserve funds for covering force close scenarios
		/// @dev Extra collateral PartyB deposits as a safety buffer. Used during force close
		///      if their allocated balance is insufficient. Not used in cross mode.
		mapping(address => uint256) reserveVault;
		/// @notice List of PartyBs that PartyA has open positions with
		/// @dev Used for symbol access control - PartyA can only trade symbols that ALL connected
		///      PartyBs support (not blacklisted and whitelisted). Also enforces maxPartyAConnectionLimit.
		///      Added when first position opens with a PartyB, removed when last position closes.
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
		/// @notice Open trading fees reserved from PartyA allocated balance for pending or locked quotes
		mapping(address => uint256) partyAReservedOpenFees;
		/// @notice Escrowed funds from LATE/OVERDUE liquidations awaiting CH distribution
		/// @dev Created at settlement when liquidation type is LATE or OVERDUE. CH distributes via distributeLiquidationEscrow.
		///      Per-partyA (only one active liquidation per partyA). Accumulates if CH hasn't distributed before next liquidation.
		mapping(address => uint256) liquidationEscrow;
		/// @notice PartyA's excess balance from deferred liquidation (current balance minus historical insolvency point)
		/// @dev Always returned to partyA at settlement regardless of liquidation type. Not accessible by clearing house.
		mapping(address => uint256) partyADeferredBalance;
		/// @notice Conservative reserve of funds PartyB owes to pending PartyA liquidation settlements.
		/// @dev Equals the sum of max(0, actualAmount) across all pending settlementStates for this PartyB.
		///      It is tracked for all PartyBs and applied only in cross mode. This prevents PartyB from
		///      switching modes between liquidatePositionsPartyA and settlePartyALiquidation, and prevents
		///      cross-mode PartyB from extracting funds between liquidatePositionsPartyA and
		///      settlePartyALiquidation by subtracting this reserve from effective available balance
		///      during deallocateForPartyB.
		mapping(address => uint256) partyBLiquidationSettlementReserve;
		/// @notice Whether an active PartyA liquidation uses signed PartyB-symbol snapshots.
		/// @dev Keyed by PartyA and liquidationId.
		mapping(address => mapping(bytes => bool)) liquidationUsesPartyBSymbolSnapshots;
		/// @notice Signed price and cumulative funding snapshots per PartyA liquidation, PartyB, and symbol.
		mapping(address => mapping(bytes => mapping(address => mapping(uint256 => LiquidationPartyBSymbolSnapshot)))) liquidationPartyBSymbolSnapshots;
		/// @notice Per-settlement contribution included in partyBLiquidationSettlementReserve.
		/// @dev Keyed by PartyA then PartyB so reserve cleanup is independent from the PartyB's current mode.
		mapping(address => mapping(address => uint256)) partyBLiquidationSettlementReserveContributions;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = ACCOUNT_STORAGE_SLOT;
		assembly {
			l.slot := slot
		}
	}
}
