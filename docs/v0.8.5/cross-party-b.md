# Cross Mode for Solvers

In earlier versions of the Symmio protocol, PartyB balances were isolated per PartyA. To open positions with multiple PartyAs, a PartyB was required to allocate and lock a separate balance for each counterparty. Each allocation was managed independently and could only be used to cover positions opened with that specific PartyA.

This fragmentation created a structural inefficiency in capital utilization. Because each allocation was evaluated in isolation, liquidation risk was also assessed independently. A PartyB could find itself liquidated on positions with one PartyA simply because the allocated balance for that counterparty was insufficient — even if, when considering all positions together, PartyB remained solvent overall.

Cross mode makes it possible for PartyBs to be cross-margined with users — a single pooled balance covers all positions across all PartyAs. But the change has far-reaching consequences for nonce handling, settlement, force close, and liquidation, each of which is explained below.

## Why Cross Mode Requires Trust

A solver can close a position at any price it wants. In isolated mode this was contained: the worst case affected only one PartyA. In cross mode, a solver could "late-liquidate" itself across multiple PartyAs by transferring its funds to one PartyA via manipulated close prices.

Because of this risk, cross mode is restricted to trusted solvers. Symmio's off-chain monitoring and anomaly-detection systems watch PartyB actions 24/7 and will suspend PartyB — or any user — if bad behavior is detected (whether intentional, due to a bug, or caused by a compromise).

## Activation

Activating cross mode for a PartyB is a multi-step process:

1. **Migration (performed by the Symmio team upon upgrade).** Immediately after the contract upgrade, the Symmio team runs two migration functions while the system is paused:

   - `migrateQuotes(quoteIds[])` on the `MigrationFacet` — backfills v0.8.5 derived state for all active positions: aggregated positions, funding baselines, the `partyBPositionsCount[partyB][address(0)]` total positions counter, and connection tracking.

   - `migrateCrossLockedValues(partyB, partyAs[])` on the `MigrationFacet` — aggregates all per-PartyA allocated balances, locked balances, and pending locked balances into the cross bucket (`address(0)`):
     ```
     partyBAllocatedBalances[partyB][address(0)] += partyBAllocatedBalances[partyB][partyA]  (for each partyA)
     partyBLockedBalances[partyB][address(0)]    += partyBLockedBalances[partyB][partyA]
     partyBPendingLockedBalances[partyB][address(0)] += partyBPendingLockedBalances[partyB][partyA]
     ```
     This function reverts if called twice for the same PartyB.

2. **Global feature flag.** After migration is complete, an admin with `MIGRATION_ROLE` calls `setCrossPartyBModeActivated(true)` on the `ControlFacet`. This enables the feature protocol-wide.

3. **Activation (one of two paths):**
   - **Admin path**: An admin with `MIGRATION_ROLE` calls `setCrossPartyB(partyB, true)` on the `ControlFacet`. Requires the global flag to be on and the PartyB to be registered. Does not check migration status on-chain.
   - **Self-activation path**: The PartyB itself calls `activateCrossPartyB()` on the `PartyBAccountFacet`. Requires the global flag to be on and cross mode to not already be active.

After activation, `address(0)` becomes the PartyB's allocation key. The solver only needs to allocate to `address(0)` — no need to allocate/deallocate per PartyA. The helper `LibAccount.partyBAllocationKey(partyB, partyA)` returns `address(0)` when cross mode is active, and `partyA` otherwise. All balance functions (available balance, locked balance calculations) use this key transparently.

### Deactivation

An admin with `MIGRATION_ROLE` can call `setCrossPartyB(partyB, false)` to disable cross mode. There is no on-chain guard that checks for zero open positions at the contract level for admin deactivation — the operational constraint is enforced off-chain.

### Allocation in Cross Mode

When cross mode is active, `allocateForPartyB` and `deallocateForPartyB` require `partyA == address(0)`. Calling with any other `partyA` address reverts with `"Cross partyB mode is active"`. Similarly, `transferAllocation` (which moves funds between per-PartyA buckets) reverts entirely in cross mode since it is meaningless when everything is pooled.

### Dual-Tracking of Locked Balances

Even though the allocation key is `address(0)` in cross mode, the contract always maintains **both** per-PartyA and cross locked balances. Every call to `addToPartyBLockedBalances`, `subFromPartyBLockedBalances`, `addToPartyBPendingLockedBalances`, and `subFromPartyBPendingLockedBalances` updates both `[partyB][partyA]` and `[partyB][address(0)]`. This allows the system to compute per-PartyA solvency in isolated mode or aggregate solvency in cross mode using the same storage.

---

## Nonce Handling

### The Problem

Before cross mode, PartyB nonces were scoped per PartyA: `partyBNonces[partyB][partyA]`. Each PartyA-PartyB pair had its own nonce, and signatures included this nonce to prevent replay attacks. This worked because operations with different PartyAs were completely independent.

In cross mode, a global nonce (`partyBNonces[partyB][address(0)]`) replaces the per-PartyA nonce for solvency purposes. But using a single global nonce in signatures would create a bottleneck: PartyB could not sign operations for PartyA₁ and PartyA₂ in parallel, because each signature would need the latest global nonce, and whichever lands first would invalidate the other.

### The Solution: Zero Nonce in Signatures

When cross mode is enabled, the nonce included in PartyB signatures for opening and closing positions is **zero** (a constant), not the actual nonce. This is implemented in `LibAccount.getPartyBSignatureNonce`:

```solidity
function getPartyBSignatureNonce(address partyB, address partyA, bool useCrossNonce) internal view returns (uint256) {
    if (MAStorage.layout().crossModeEnabledForPartyB[partyB]) {
        return useCrossNonce ? accountLayout.partyBNonces[partyB][address(0)] : 0;
    }
    return accountLayout.partyBNonces[partyB][partyA];
}
```

The `useCrossNonce` flag controls which behavior is used:
- **`false`** (default): Returns `0` in cross mode. Used for `PairUpnlAndPriceSig` (open/close/forceClose/funding rate signatures) where PartyB needs to operate in parallel with different PartyAs.
- **`true`**: Returns the actual cross nonce (`partyBNonces[partyB][address(0)]`). Used for `SingleUpnlSig` in deallocate operations, where nonce protection is still needed because deallocate affects the shared pool.

### Nonce Increment

Even though signatures ignore the nonce, the on-chain nonce still increments on every state-changing operation. `LibAccount.increasePartyBNonce` always increments **both** the per-PartyA nonce and the cross nonce:

```solidity
function increasePartyBNonce(address partyB, address partyA) internal {
    accountLayout.partyBNonces[partyB][partyA]++;
    accountLayout.partyBNonces[partyB][address(0)]++;
}
```

This keeps the cross nonce as a monotonically increasing counter that reflects total state changes, even though it is not checked in most signatures.

### Unified Settlement Nonce

The unified settlement signature (`verifyUnifiedSettlement`) handles nonces differently depending on mode:
- **Cross mode**: Uses `uint256(0)` as the nonce in the hash — matching the zero-nonce convention.
- **Normal mode**: Uses per-PartyA nonces for PartyB (`partyBNonces[partyB][partyAs[i]]` for each PartyA in the settlement).

---

## Settlement

### Why Unified Settlement Was Needed

The legacy `settleUpnl` function settles one PartyA at a time: it takes a single `partyA` address, iterates over quotes belonging to different PartyBs, and tracks PartyB balances per PartyA. This design works for isolated mode but cannot model cross mode correctly, because in cross mode PartyB's collateral is pooled — settlement must treat PartyB's balance as one shared pool across all PartyAs.

### How `settleUpnlUnified` Works

`settleUpnlUnified` (in `LibSettlement`) inverts the settlement axis: it settles one **PartyB** across one or more **PartyAs** in a single transaction.

**Signature structure (`UnifiedSettlementSig`):**
```
partyB           — the PartyB being settled
partyAs[]        — array of PartyA addresses involved
upnlPartyAs[]    — per-PartyA UPNLs
upnlPartyB       — aggregated UPNL (cross mode)
upnlPartyBPerPartyA[] — per-PartyA UPNLs for PartyB (normal mode)
quotesSettlementsData[] — per-quote data with partyAIndex mapping each quote to its partyA
```

**Settlement flow:**

1. **Validate** lengths, solvency of all parties, and that no one is being liquidated.
2. **Process quotes**: For each quote, validate it belongs to the specified `partyB` and `partyAs[partyAIndex]`. Calculate the settlement amount from the price change (`openedPrice → updatedPrice`). Update the quote's `openedPrice`.
3. **Apply settlements per PartyA**: For each PartyA, compute the net settlement amount. If positive (PartyB loses, PartyA gains), deduct from `partyBAllocatedBalances[partyB][allocKey]` and credit to `allocatedBalances[partyA]`. If negative, the reverse. The `allocKey` is `address(0)` in cross mode, `partyA` in normal mode.

**Key differences from legacy `settleUpnl`:**

| Aspect | Legacy `settleUpnl` | Unified `settleUpnlUnified` |
|--------|---------------------|----------------------------|
| Axis | One PartyA, multiple PartyBs | One PartyB, multiple PartyAs |
| PartyB balance key | `partyBAllocationKey(partyB, partyA)` | `address(0)` (cross) or `partyA` (normal) |
| Solvency check | Per-PartyA for PartyB | Aggregated (cross) or per-PartyA (normal) |
| Nonce in signature | Per-PartyA PartyB nonce | Zero (cross) or per-PartyA (normal) |
| Cross mode support | Partially (uses allocation key) | Native |

The legacy `settleUpnl` is kept for backward compatibility with integrations that have not migrated.

### Quote Subset Constraints

Solvency is validated using aggregate UPNL -- which includes unrealized gains from positions not being settled -- but each party's `uint256` balance must independently absorb the realized settlement amount. If a party is solvent in aggregate but the settlement loss from the chosen quote subset exceeds their raw allocated balance, the transaction will revert.

Callers must select quote subsets where each individual party's allocated balance can cover the realized settlement:

- **PartyA**: The net settlement loss from quotes with this specific PartyB must not exceed `allocatedBalances[partyA]`.
- **Non-cross PartyB**: The net settlement loss from quotes with a specific PartyA must not exceed `partyBAllocatedBalances[partyB][partyA]`.
- **Cross PartyB**: The **net** settlement loss across all PartyAs must not exceed `partyBAllocatedBalances[partyB][address(0)]`. The ordering of PartyAs in the signature does not matter -- the contract accumulates a signed delta and applies it once.

If a desired settlement would violate these constraints, callers should either include offsetting (winning) quotes in the batch, split the settlement into multiple transactions, or wait for the party to deposit/allocate additional funds.

### Settlement Examples

**Scenario 1: PartyA lacks money, PartyB settles to charge PartyA.**
PartyA has a position to close but insufficient available balance. PartyB uses `settleUpnlUnified` to realize PartyA's positive uPnL from other open positions with this PartyB. The realization increases PartyA's allocated balance and decreases PartyB's allocated balance. Once PartyA is funded, PartyB can execute `FillClose`.

**Scenario 2: PartyB lacks money, PartyB settles to charge itself.**
PartyA requests a close but PartyB lacks available balance to pay. PartyB settles its own profitable positions — the `settleUpnlUnified` flow realizes PartyB's positive uPnL, moving funds into its cross pool (or per-PartyA bucket). This is a PartyB action and does not require PartyA's participation.

---

## Force Close

### Why the Step-Based Flow

The original `forceClosePosition` on `ForceActionsFacet` performs everything in a single transaction: validate, compute close price, check solvency, close the position. This worked in isolated mode where settlement was scoped to one PartyA. In cross mode, settlement needs a unified signature covering multiple PartyAs, and the settlement + close must use consistent price snapshots. Bundling everything into one transaction with potentially large settlement data would hit gas limits and complicate the signature flow.

The `ForceCloseStepsFacet` breaks force close into steps that can be executed in separate transactions.

Additionally, the legacy `forceClosePosition` **explicitly rejects** cross-mode PartyBs:
```solidity
require(!MAStorage.layout().crossModeEnabledForPartyB[partyB], "ForceActionsFacet: Cross partyB mode enabled");
```

### The 3-Step Flow

**Step 1 — `initializeForceClose(quoteId, HighLowPriceSig)`**

Validates force-close conditions (quote in `CLOSE_PENDING`, cooldowns met, order type is LIMIT, close price reached). Computes the close price with penalty. Checks that PartyA remains solvent after the close. Stores a `ForceCloseDetail` snapshot:
- `closePrice` — the computed force-close price (does not change after init)
- `upnlPartyB` — PartyB's uPnL from the signature
- `currentPrice` — the current market price from the signature
- `inProgress = true` — gates subsequent steps

**Step 2 — `settleUpnlForForceClose(quoteId, UnifiedSettlementSig, updatedPrices[])` (optional, repeatable)**

Calls `settleUpnlUnified` with `isForceClose = true`, which relaxes the "caller must have a position" check. The settlement can target any PartyB — not just the one on the force-close quote. Which positions can be settled depends on the scenario:

- **PartyA lacks funds**: Settle PartyA's profitable positions with **any other PartyB** (`sig.partyB != forceCloseQuote.partyB`). This funds PartyA's `allocatedBalances` so the close can proceed. No restriction on which PartyBs or PartyAs are involved.

- **PartyB (non-cross) lacks funds**: Settle the **same PartyB's** profitable positions (`sig.partyB == forceCloseQuote.partyB`), but only with the **force-close quote's PartyA**. In isolated mode each per-PartyA bucket is separate, so settling with a different PartyA would fund the wrong bucket. The contract enforces this: `require(sig.partyAs.length == 1 && sig.partyAs[0] == forceCloseQuote.partyA)`.

- **PartyB (cross) lacks funds**: Settle the **same PartyB's** positions with **any PartyA**. Since everything goes to the `address(0)` pool, settling with any PartyA funds the same shared bucket.

After settlement, the stored `upnlPartyB` snapshot is adjusted by the settlement delta (only when `sig.partyB == forceCloseQuote.partyB`) so that the finalize step uses consistent numbers:
- **Cross mode**: `upnlPartyB += sum(settleAmountsPerPartyA)` — all settlement amounts affect the single pool.
- **Normal mode**: `upnlPartyB += settleAmountsPerPartyA[forceClosePartyAIndex]` — only the settlement with the force-close quote's PartyA is relevant.

The `timestamp` is also advanced, which allows a fresh `refreshForceCloseSnapshot` to be used later.

**Step 3 — `finalizeForceClose(quoteId, PairUpnlAndPriceSig)`**

First refreshes the uPnL/currentPrice snapshot with a fresh Muon signature (ensuring partyA solvency at the latest prices), then closes the position. The close behavior differs by mode:

- **Normal PartyB**: Uses `closeQuoteWithReserveFallback`. If PartyB is solvent after close, emits `ForceClosePosition`. If insolvent, tries the reserve vault as a fallback. If the reserve vault covers the deficit, closes the position. If not, triggers `liquidatePartyB` — the normal isolated-mode PartyB liquidation.

- **Cross PartyB**: Uses `closeQuoteCrossIgnoringUpnl`. First tries to close using the uPnL-based solvency check. If PartyB is insolvent with uPnL, retries with `upnlPartyB = 0` (ignoring uPnL). If the close is possible ignoring uPnL (i.e., the allocated balance minus locked balances covers the cost), the position closes and is marked `CLOSED_INSOLVENT`. If even ignoring uPnL is insufficient, the transaction reverts with `"Insufficient balance"`. **PartyB is never liquidated during cross-mode force close** — the position either closes or the transaction reverts.

  When the close succeeds but PartyB is marked insolvent, the facet emits both `ForceClosePosition` and `ForceClosePartyBInsolvent`. The second event signals to off-chain monitoring that the ClearingHouse should investigate.

### Convenience Function

`forceCloseAndSettlePositionsUnified` combines all three steps in a single transaction: init → settle (if `updatedPrices` is non-empty) → finalize. Unlike the step-by-step flow, the finalize here does **not** take a fresh `PairUpnlAndPriceSig` — it uses the uPnL and currentPrice values from the init signature directly (adjusted by any settlement delta). This works when the settlement data is small enough to fit in one transaction's gas limit.

### Reserve Vault

In normal (isolated) mode, the reserve vault (`reserveVault[partyB]`) serves as a last-resort fallback during force close. If PartyB is insolvent after the close but the reserve vault covers the deficit, the deficit is transferred from the reserve vault into PartyB's allocated balance, and the close proceeds.

In cross mode, the reserve vault is **not used** during force close. The cross-mode path uses the "ignore uPnL" fallback instead.

---

## Liquidation via ClearingHouse

With cross mode enabled, PartyB liquidation becomes impractical on-chain because there can be thousands of positions and PartyAs involved. The decentralized liquidator flow (used for isolated-mode PartyBs) cannot safely unwind a shared pool across multiple counterparties.

To address this, liquidation of cross-enabled PartyBs is handled by the **ClearingHouse**, a privileged off-chain Symmio entity. The ClearingHouse computes liquidation outcomes off-chain and executes balance updates on-chain through the `ClearingHouseFacet`. All functions require the `CLEARING_HOUSE_ROLE`. The ClearingHouse is fully trusted — `liquidateCrossPartyB` takes the UPNL and liquidation parameters directly from the ClearingHouse without requiring a Muon oracle signature.

The ClearingHouse handles two distinct liquidation flows:
1. **Cross PartyB liquidation** — when a cross-mode PartyB becomes insolvent
2. **PartyA takeover** — when a PartyA liquidation gets stuck or corrupted

Both flows, their mechanics, and how they interact with each other are documented in detail in [ClearingHouse.md](./ClearingHouse.md).

### Why Cross PartyB Liquidation Is Different

When an isolated-mode PartyB got liquidated, only that one PartyA was affected. In cross mode, liquidation of a solver affects **all** users trading with that solver — all positions are closed. This would be a terrible experience for users and for PartyB itself, because PartyB would need to pay many CVAs. This is why soft liquidation exists: to catch and penalize PartyBs before they reach full insolvency, making actual cross liquidation a rare last resort.
