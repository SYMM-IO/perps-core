# Virtual Account Lifecycle Hooks

Virtual Accounts (VAs) are deterministic addresses managed by the AccountLayer that act as `partyA` on Symmio Core. When the AccountLayer is registered as a **system hook** (`affiliateHooks[address(0)]`) on Symmio Core, it receives callbacks on position lifecycle events to automatically clean up VAs when their quotes are fully resolved.

## Hook Entry Points

The `SymmioHookFacet` on the AccountLayer diamond implements these hooks:

| Hook | Fired When | Action |
|------|-----------|--------|
| `onOpenPosition` | Position opened | No-op |
| `onClosePosition` | Position closed (full or partial) | Remove quoteId from VA if full close; attempt deletion |
| `onCancelQuote` | Quote cancelled/expired/liquidated | Remove quoteId from VA; attempt deletion |
| `onFeeCharged` | Fee charged | No-op |
| `onLiquidationSettled` | Liquidation fully settled | Attempt deferred VA deletion |

## Core Logic

### Partial Close Detection

`_removeQuoteFromAccount(quoteId, partyA, partyB)` compares core state with VA tracked state:

```
coreTotal = partyAPositionsCount(partyA) + getPartyAPendingQuotes(partyA).length
```

- If `coreTotal < vData.quoteIds.length()` -- a quote was fully resolved (closed/cancelled/liquidated), so the quoteId is removed from the VA's tracking set.
- If `coreTotal >= vData.quoteIds.length()` -- this is a partial close; the position is still open, so the quoteId is kept.

### Deletion Deferral

`_tryDeleteVirtualAccount(partyA, partyB)` gates deletion with three checks:

| Check | Protects Against | Cleared By | Recovery Hook |
|-------|-----------------|------------|---------------|
| `isPartyALiquidated(partyA)` | Premature deletion during partyA liquidation (reimbursement not yet credited) | `settlePartyALiquidation` clears `liquidationStatus` | `onLiquidationSettled` |
| `isPartyATakeoverInProgress(partyA)` | Premature deletion during CH takeover (funds not yet distributed) | `settlePartyATakeover` clears `inProgress` | `onLiquidationSettled` |
| `getPartyBCrossLiquidationStatus(partyB)` | Premature deletion during cross partyB liq (funds not yet distributed) | `settleCrossPartyBLiquidation` clears `inProgress` | `onLiquidationSettled` (passes `address(0)`, skipping this check) |

The `partyB` parameter comes directly from the hook call (`onClosePosition` / `onCancelQuote`). For `onLiquidationSettled`, `address(0)` is passed because settlement is already complete -- no cross partyB check is needed.

## Normal Flows

### Full Close (`fillCloseRequest`)

1. `LibQuoteClose.closeQuote()` removes position from `partyAPositionsCount` **before** firing hook
2. `onClosePosition` fires -- `coreTotal < quoteIds.length()` -- quoteId removed
3. If last quoteId: `_tryDeleteVirtualAccount` -- no liquidation active -- **VA deleted**

### Partial Close (`fillCloseRequest` with partial fill)

1. Position stays open; `partyAPositionsCount` unchanged
2. `onClosePosition` fires -- `coreTotal >= quoteIds.length()` -- quoteId **kept**
3. VA persists until full close

### Cancel Quote (`requestToCancelQuote`, `acceptCancelRequest`, `expireQuote`)

1. Quote removed from `partyAPendingQuotes` **before** hook fires
2. `onCancelQuote` fires -- `coreTotal < quoteIds.length()` -- quoteId removed
3. If last quoteId: **VA deleted**

### Force Cancel Quote (`forceCancelQuote`)

1. Quote removed from pending via `removeFromPendingQuotes` **before** hook fires
2. `onCancelQuote` fires -- quoteId removed
3. If last quoteId: **VA deleted**

### Force Close (`finalizeForceClose`)

Uses shared `LibQuoteClose.closeQuote()` path -- same as full close above.

## Liquidation Flows

### PartyA Normal Liquidation

**Trigger:** VA becomes insolvent.

1. **`liquidatePartyA(partyA)`** -- sets `liquidationStatus[partyA] = true`
2. **`setSymbolsPrice(partyA)`** -- sets liquidation prices per symbol
3. **`liquidatePendingPositionsPartyA(partyA)`** -- cancels all pending quotes
   - Collects quoteIds during loop
   - `delete partyAPendingQuotes[partyA]`
   - Fires `onCancelQuote` per quote **after** delete -- quoteIds removed from VA
   - `_tryDeleteVirtualAccount` -- `isPartyALiquidated = true` -- **deferred**
4. **`liquidatePositionsPartyA(partyA, quoteIds)`** -- liquidates open positions (paginated)
   - Removes from open positions, decrements `partyAPositionsCount`
   - Fires `onClosePosition` per quote **after** state update -- quoteIds removed from VA
   - `_tryDeleteVirtualAccount` -- `isPartyALiquidated = true` -- **deferred**
5. **`settlePartyALiquidation(partyA, partyBs)`** -- settles funds (paginated across partyBs)
   - When fully settled: `liquidationStatus[partyA] = false`
   - Fires `onLiquidationSettled(partyA)` -- `isPartyALiquidated = false` -- **VA deleted**

**Fund flow:** Reimbursement credited to `allocatedBalances[VA]` during settlement. `_deleteVirtualAccount` calls `zeroUpnlDeallocate` to sweep to parent.

### ClearingHouse PartyA Takeover

**Trigger:** ClearingHouse takes over a partyA's liquidation.

1. **`initiatePartyATakeover(partyA)`** -- sets `partyATakeoverDetails[partyA].inProgress = true`
2. **`liquidatePendingPositionsForClearingHouse(partyA, [])`** -- takeover path
   - Collects quoteIds, `delete partyAPendingQuotes[partyA]`
   - Fires `onCancelQuote` per quote **after** delete -- quoteIds removed
   - `_tryDeleteVirtualAccount` -- `isPartyATakeoverInProgress = true` -- **deferred**
3. **`liquidatePositionsForClearingHouse(partyA, quoteIds, prices)`** -- takeover path
   - Fires `onClosePosition` per quote after state update -- quoteIds removed
   - `_tryDeleteVirtualAccount` -- `isPartyATakeoverInProgress = true` -- **deferred**
4. **`distributeForClearingHouse(partyA, ...)`** -- distributes funds
   - Credits `allocatedBalances[VA]` with reimbursement
5. **`settlePartyATakeover(partyA, settledPartyBs)`** -- clears takeover state
   - `inProgress = false`
   - Fires `onLiquidationSettled(partyA)` -- **VA deleted**

### ClearingHouse Cross PartyB Liquidation

**Trigger:** A cross partyB becomes insolvent across all its partyAs.

1. **`liquidateCrossPartyB(partyB)`** -- sets `crossLiquidationDetails[partyB].inProgress = true`
2. **`liquidatePendingPositionsForClearingHouse(partyB, [va1, va2, ...])`** -- cross path
   - Per partyA: swap-and-pop loop, fires `onCancelQuote` **after** pop -- quoteIds removed
   - `_tryDeleteVirtualAccount(partyA, partyB)` -- `getPartyBCrossLiquidationStatus(partyB) = true` -- **deferred**
3. **`liquidatePositionsForClearingHouse(partyB, quoteIds, prices)`** -- cross path
   - Fires `onClosePosition` per quote after state update -- quoteIds removed
   - `_tryDeleteVirtualAccount(partyA, partyB)` -- cross liq still active -- **deferred**
4. **`distributeForClearingHouse(partyB, [va1, ...], ...)`** -- distributes from `deallocatedPool`
   - Credits `allocatedBalances[VA]` with reimbursement
5. **`settleCrossPartyBLiquidation(partyB, [va1], false)`** -- partial settlement (pagination)
   - Fires `onLiquidationSettled(va1)` with `address(0)` -- skips cross check -- **VA1 deleted**
   - `inProgress` still `true` (no finalize)
6. **`settleCrossPartyBLiquidation(partyB, [va2], true)`** -- final batch
   - Fires `onLiquidationSettled(va2)` -- **VA2 deleted**
   - `inProgress = false` (finalize clears it)

**Note:** `onLiquidationSettled` passes `address(0)` as `partyB`, which skips the cross check. This is correct because the hook only fires for partyAs that have already been distributed to -- their funds are safe.

### Isolated PartyB Liquidation

**Trigger:** PartyB becomes insolvent against a specific partyA (VA).

1. **`liquidatePartyB(partyB, partyA)`** -- `LibLiquidation.liquidatePartyB`
   - Cancels pending quotes (swap-and-pop), collects quoteIds
   - Transfers partyB's allocated balance to partyA: `allocatedBalances[VA] += value`
   - `delete partyBPendingQuotes`, zeroes partyB balances, increments nonce
   - Fires `onCancelQuote` per quote **after** all state changes -- quoteIds removed
   - `_tryDeleteVirtualAccount(partyA, partyB)` -- partyA NOT liquidated, partyB NOT cross -- checks pass
   - If VA has open positions: `quoteIds.length() != 0` -- not deleted yet
2. **`liquidatePositionsPartyB(partyB, partyA, priceSig)`** -- closes open positions
   - Per quote: settles PnL, removes from open positions
   - Fires `onClosePosition` per quote after state update -- quoteIds removed
   - When last quoteId removed: `_tryDeleteVirtualAccount` -- **VA deleted immediately**

**No deferral needed:** PartyA is not liquidated. PartyB is not in cross mode. VA is deleted as soon as all quotes are resolved.

**No settlement hook needed:** Funds are settled inline during `liquidatePartyB` (pending) and `liquidatePositionsPartyB` (positions). No deferred distribution step exists.

## Hook Firing Order

All hooks must fire **after** core state changes are complete so that `_removeQuoteFromAccount` can correctly compare `coreTotal` with `vData.quoteIds.length()`.

Places where this was specifically addressed:
- `liquidatePendingPositionsPartyA` -- hooks fire after `delete partyAPendingQuotes`
- `liquidatePendingPositionsForClearingHouse` (both paths) -- hooks fire after swap-pop loop / delete
- `LibLiquidation.liquidatePartyB` -- hooks fire after all balance updates and `delete partyBPendingQuotes`