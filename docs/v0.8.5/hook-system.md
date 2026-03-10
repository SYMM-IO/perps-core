# Hook System

The Hook System is SYMMIO's extensibility layer for reacting to core trading events on-chain. It allows external contracts to receive callbacks when positions are opened, closed, or cancelled, when close requests are expired/force-cancelled, and when trading fees are charged. Hooks are registered per-affiliate, enabling each frontend or integration partner to run its own custom logic — campaign tracking, cashback distribution, loyalty programs, analytics — without modifying the core protocol.

Hooks are deeply integrated into the trading lifecycle and cover open/close/cancel/liquidation/close-expiry paths.

## ISymmioHook Interface

Every hook contract must implement the `ISymmioHook` interface:

```solidity
// contracts/core/interfaces/ISymmioHook.sol

interface ISymmioHook {
    enum TradingFeeType {
        OPEN,
        CLOSE
    }

    function onOpenPosition(
        uint256 quoteId,
        uint256 filledAmount,
        uint256 openedPrice,
        address partyA,
        address partyB
    ) external;

    function onClosePosition(
        uint256 quoteId,
        uint256 filledAmount,
        uint256 closedPrice,
        address partyA,
        address partyB
    ) external;

    function onCancelQuote(
        uint256 quoteId,
        address partyA,
        address partyB
    ) external;

    function onCloseExpired(
        uint256 quoteId,
        address partyA,
        address partyB
    ) external;

    function onFeeCharged(
        uint256 quoteId,
        uint256 amount,
        address partyA,
        address partyB,
        uint256 symbolId,
        address affiliate,
        TradingFeeType feeType
    ) external;

}
```

**`onOpenPosition`** — Called when PartyB fills a quote and opens a position. `filledAmount` is the quantity filled (may be partial for LIMIT orders). `openedPrice` is the execution price.

**`onClosePosition`** — Called when a position is closed, whether through a normal close request fill or through liquidation. `filledAmount` is the closed quantity and `closedPrice` is the execution/liquidation price.

**`onCancelQuote`** — Called when a quote is cancelled or expires before being filled. This covers direct cancellation by PartyA, accepted cancellation by PartyB, expiration, and cancellation during ClearingHouse liquidation.

**`onCloseExpired`** — Called when a close request is removed and the quote returns to `OPENED` (expiration of `CLOSE_PENDING`/`CANCEL_CLOSE_PENDING`, or force-cancel of `CANCEL_CLOSE_PENDING`).

**`onFeeCharged`** — Called alongside `onOpenPosition` and `onClosePosition` to report the exact fee amount charged. The `TradingFeeType` enum distinguishes between open fees and close fees. The `affiliate` address and `symbolId` are included so the hook can attribute fees to the correct campaign.

## Hook Registration

Hooks are stored in `AffiliateStorage` as a simple mapping from affiliate address to hook contract address:

```solidity
// contracts/core/storages/AffiliateStorage.sol

/// @notice Hook contracts called on protocol events per affiliate
/// @dev Called on onOpenPosition, onClosePosition, onCancelQuote,
///      onCloseExpired, and onFeeCharged events.
///      address(0) key is the system-wide hook. Enables custom integrations.
mapping(address => address) affiliateHooks;
```

### Per-Affiliate Hooks

Each affiliate can have one hook contract. When a quote is created through a specific affiliate, all lifecycle events for that quote call the affiliate's hook. Registration is done through `ControlFacet` by an address holding `INTEGRATION_ADMIN_ROLE`:

```solidity
// contracts/core/facets/Control/ControlFacet.sol

function registerHook(
    address affiliate,
    address hook
) external onlyRole(LibAccessibility.INTEGRATION_ADMIN_ROLE) {
    AffiliateStorage.layout().affiliateHooks[affiliate] = hook;
    emit RegisterHook(affiliate, hook);
}
```

### System-Wide Hook (address(0))

The `address(0)` key acts as a system-wide hook. When set, this hook is called for **every** quote regardless of its affiliate. Both hooks fire on every event: first the affiliate-specific hook, then the system hook.

```solidity
address affiliateHook = AffiliateStorage.layout().affiliateHooks[quote.affiliate];
address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
```

This dual-hook pattern means a single trading event can trigger up to 2 hook calls per callback type (e.g., opening a position fires `onOpenPosition` on both the affiliate hook and the system hook, plus `onFeeCharged` on both — 4 external calls total).

### Querying Hooks

The `ViewFacet` exposes a getter:

```solidity
function getAffiliateHook(address affiliate) external view returns (address hook) {
    return AffiliateStorage.layout().affiliateHooks[affiliate];
}
```

## Where Hooks Fire in the Lifecycle

The following table maps every hook call site to the contract function that triggers it:

| Event | Callback(s) | Source File | Trigger |
|---|---|---|---|
| Position opened | `onOpenPosition` + `onFeeCharged(OPEN)` | `LibPartyBPositionsActions.openPosition` | PartyB fills a quote |
| Position closed | `onClosePosition` + `onFeeCharged(CLOSE)` | `LibQuoteClose.closeQuote` | PartyB fills a close request |
| Quote cancelled (PartyA) | `onCancelQuote` | `PartyAFacetImpl.requestToCancelQuote` | PartyA cancels a PENDING quote |
| Quote cancelled (PartyB) | `onCancelQuote` | `PartyBQuoteActionsFacetImpl.acceptCancelRequest` | PartyB accepts a cancel request |
| Quote force-cancelled | `onCancelQuote` | `ForceActionsFacetImpl.forceCancelQuote` | PartyA force-cancels a previously LOCKED quote after cooldown |
| Quote expired | `onCancelQuote` | `LibQuoteClose.expireQuote` | Quote deadline passes |
| Pending liquidated in PartyA liquidation | `onCancelQuote` | `PartyALiquidationFacetImpl.liquidatePendingPositionsPartyA` | PartyA liquidation on pending quotes |
| Pending liquidated in PartyB liquidation | `onCancelQuote` | `PartyBLiquidationFacetImpl.liquidatePartyB`, `LibForceActions.liquidatePartyB` | PartyB liquidation path |
| PartyB liquidation | `onClosePosition` | `PartyBLiquidationFacetImpl.liquidatePositionsPartyB` | Isolated-mode PartyB liquidation |
| PartyA liquidation | `onClosePosition` | `PartyALiquidationFacetImpl.liquidatePositionsPartyA` | PartyA liquidation |
| Close request expired/force-cancelled | `onCloseExpired` | `LibQuoteClose.expireQuote`, `ForceActionsFacetImpl.forceCancelCloseRequest` | Close request is removed and quote reopens |
| ClearingHouse pending cancel | `onCancelQuote` | `ClearingHouseFacetImpl._callCancelQuoteHooksAndUpdateStatus` | Cross-PartyB or PartyA takeover liquidation (pending quotes) |
| ClearingHouse position liquidation | `onClosePosition` | `ClearingHouseFacetImpl.liquidatePositionsForClearingHouse` | Cross-PartyB or PartyA takeover liquidation (open positions) |

### Open Position Flow

In `LibPartyBPositionsActions.openPosition`, after the position is fully created and all balances updated, four hook calls fire:

```solidity
uint256 openFee = (filledAmount * quote.openedPrice * quote.tradingFee) / 1e36;

// 1. Affiliate hook: onOpenPosition
LibHook.safeCall(
    affiliateHook,
    abi.encodeCall(ISymmioHook.onOpenPosition,
        (quoteId, filledAmount, openedPrice, quote.partyA, quote.partyB)),
    quoteId
);
// 2. Affiliate hook: onFeeCharged (OPEN)
LibHook.safeCall(
    affiliateHook,
    abi.encodeCall(ISymmioHook.onFeeCharged,
        (quoteId, openFee, quote.partyA, quote.partyB,
         quote.symbolId, quote.affiliate, ISymmioHook.TradingFeeType.OPEN)),
    quoteId
);
// 3. System hook: onOpenPosition
LibHook.safeCall(systemHook, ...);
// 4. System hook: onFeeCharged (OPEN)
LibHook.safeCall(systemHook, ...);
```

### Close Position Flow

In `LibQuoteClose.closeQuote`, after PnL settlement, fee deduction, and status update, the same four-call pattern fires with `onClosePosition` and `onFeeCharged(CLOSE)`.

### Cancel / Expire Flow

Cancel and expire paths use the convenience function `LibHook.callCancelQuoteHooks`, which calls `onCancelQuote` on both hooks:

```solidity
function callCancelQuoteHooks(
    uint256 quoteId,
    address partyA,
    address partyB,
    address affiliate
) internal {
    address affiliateHook = AffiliateStorage.layout().affiliateHooks[affiliate];
    address systemHook = AffiliateStorage.layout().affiliateHooks[address(0)];
    safeCall(affiliateHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quoteId, partyA, partyB)), quoteId);
    safeCall(systemHook, abi.encodeCall(ISymmioHook.onCancelQuote, (quoteId, partyA, partyB)), quoteId);
}
```

### Liquidation Flows

During liquidations (PartyA, isolated PartyB, and ClearingHouse), hooks fire via `LibHook.callClosePositionHooks` for position closures and `_callCancelQuoteHooksAndUpdateStatus` for pending quote cancellations. The liquidation price is passed as `closedPrice`, so hook contracts can distinguish normal closes from liquidations by comparing against the original `openedPrice` or by checking quote status.

## LibHook.safeCall — Security Model

`LibHook.safeCall` is the single entry point for all hook invocations. Its implementation addresses the core security concern: **a hook contract must not be able to impersonate the user whose transaction triggered the hook**.

```solidity
// contracts/core/libraries/LibHook.sol

function safeCall(address hook, bytes memory data, uint256 quoteId) internal {
    if (hook == address(0)) return;

    // Save and clear signer before external call
    address previousSigner = GlobalAppStorage.layout().signer;
    GlobalAppStorage.layout().signer = address(0);

    (bool success, bytes memory reason) = hook.call(data);

    // Revert on hook failures to avoid inconsistency
    if (!success) {
        revert HookReverted(hook, bytes4(data), quoteId, reason);
    }

    // Restore signer after hook call
    GlobalAppStorage.layout().signer = previousSigner;
}
```

### Why the Signer Is Cleared

SYMMIO uses a meta-transaction pattern where `GlobalAppStorage.signer` identifies the actual user behind a proxied call. If this signer were still set when the hook executes, a malicious hook could call back into the diamond and execute operations as that user (e.g., deallocate their funds). By clearing the signer to `address(0)` before the external call, any re-entrant call into the diamond will fail authorization checks because `LibSigner.getSigner()` returns `address(0)` — an address that holds no roles and owns no positions.

The `MaliciousHook` test contract in the repository demonstrates this protection:

```solidity
// contracts/core/test/MaliciousHook.sol

// Try to call deallocate as the user (this should fail because signer is cleared)
try ISymmioCore(symmioCore).deallocate(deallocateAmount) {
    reentrySucceeded = true;
} catch (bytes memory error) {
    reentrySucceeded = false;  // Expected: always fails
    reentryError = error;
}
```

### Revert Behavior

Hook failures cause the entire transaction to revert. This is an intentional design decision, documented in the code:

```solidity
// NOTE: We intentionally revert on hook failures for now to avoid inconsistency
if (!success) {
    revert HookReverted(hook, bytes4(data), quoteId, reason);
}
```

The `HookReverted` error includes the hook address, the function selector that failed, the quote ID, and the revert reason bytes, enabling precise diagnosis.

This means a broken or malicious hook can block the operation it is attached to. A reverting `onOpenPosition` hook prevents positions from being opened for all quotes associated with that affiliate. A reverting `onClosePosition` hook prevents positions from being closed or liquidated. This is a trust tradeoff: the protocol trusts that registered hooks are well-behaved, and the `INTEGRATION_ADMIN_ROLE` that registers hooks is responsible for vetting them.

## Security Considerations

**Hook revert blocks operations.** Because `safeCall` reverts the parent transaction on hook failure, a faulty hook can effectively freeze trading for an affiliate's users. The `INTEGRATION_ADMIN_ROLE` holder must vet hooks before registration and can remove a broken hook by calling `registerHook(affiliate, address(0))`.

**Signer cleared before hook.** The `GlobalAppStorage.signer` is set to `address(0)` before the hook call and restored afterward. This prevents the hook from acting on behalf of the user. Any call back into the diamond during hook execution will see no authenticated signer.

**No gas limit on hook calls.** The hook is called with all remaining gas. A hook that consumes excessive gas will cause the parent transaction to run out of gas. Hook implementers should keep callbacks cheap and avoid unbounded loops.

**Hook receives raw addresses, not signatures.** Hooks receive `partyA` and `partyB` as plain addresses. They do not receive Muon signatures or any cryptographic proof. The hook trusts that it is being called by the SYMMIO diamond, which should be verified via `msg.sender` checks in the hook contract (e.g., an `onlySymmio` modifier).

**Dual invocation.** Both the affiliate-specific hook and the system-wide hook fire for every event. If either reverts, the transaction reverts. This means registering a system-wide hook introduces a global dependency: if it breaks, all trading halts.

## Account Layer Integration

The account layer implements `ISymmioHook` through `SymmioHookFacet`, which is registered as a hook on the core diamond. This demonstrates a production use case where the hook maintains virtual account state:

```solidity
// contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol

function onClosePosition(
    uint256 quoteId, uint256, uint256, address partyA, address
) external onlySymmio nonReentrant whenNotPaused {
    _removeQuoteFromAccount(quoteId, partyA);
}

function onCancelQuote(
    uint256 quoteId, address partyA, address
) external onlySymmio whenNotPaused {
    _removeQuoteFromAccount(quoteId, partyA);
}
```

When all quotes for a virtual account are closed or cancelled, the hook automatically deletes the virtual account and returns remaining funds to the parent account. The `onOpenPosition`, `onCloseExpired`, and `onFeeCharged` callbacks are no-ops in this implementation but are still defined to satisfy the interface and prevent reverts.

## Use Cases

**Affiliate campaign tracking.** A hook can record every position opened through an affiliate, tracking volume, fee revenue, and user activity on-chain. The `onFeeCharged` callback provides the exact fee amount and the affiliate address, enabling transparent revenue attribution.

**Cashback and rebates.** A hook can calculate and distribute cashback to traders based on their trading volume or fee spend. The `amount` parameter in `onFeeCharged` gives the exact fee charged, from which a percentage can be rebated.

**Loyalty points and NFT minting.** A hook can mint ERC-20 loyalty tokens or ERC-721 NFTs when traders reach volume milestones. The `filledAmount * openedPrice` notional value is available from `onOpenPosition`.

**On-chain analytics.** A hook can maintain aggregate statistics — total volume per symbol, average position size, number of active traders — that other contracts or off-chain systems can query.

**Virtual account lifecycle.** As demonstrated by the account layer, a hook can manage derived state that depends on the quote lifecycle, automatically cleaning up resources when positions close.

## Related Files

| File | Role |
|---|---|
| `contracts/core/interfaces/ISymmioHook.sol` | Interface definition |
| `contracts/core/libraries/LibHook.sol` | `safeCall`, `callCancelQuoteHooks`, `callCloseExpiredHooks`, `callClosePositionHooks` |
| `contracts/core/storages/AffiliateStorage.sol` | `affiliateHooks` mapping |
| `contracts/core/facets/Control/ControlFacet.sol` | `registerHook` (registration) |
| `contracts/core/facets/ViewFacet/ViewFacet.sol` | `getAffiliateHook` (query) |
| `contracts/core/libraries/LibPartyBPositionsActions.sol` | Hook calls on position open |
| `contracts/core/libraries/LibQuoteClose.sol` | Hook calls on position close and quote expiry |
| `contracts/core/facets/PartyA/PartyAFacetImpl.sol` | Hook calls on quote cancellation |
| `contracts/core/facets/PartyBQuoteActions/PartyBQuoteActionsFacetImpl.sol` | Hook calls on accepted cancel |
| `contracts/core/facets/PartyALiquidation/PartyALiquidationFacetImpl.sol` | Hook calls during PartyA liquidation |
| `contracts/core/facets/PartyBLiquidation/PartyBLiquidationFacetImpl.sol` | Hook calls during PartyB liquidation |
| `contracts/core/facets/ClearingHouse/ClearingHouseFacetImpl.sol` | Hook calls during ClearingHouse liquidation |
| `contracts/core/test/MockHook.sol` | Test hook with configurable revert behavior |
| `contracts/core/test/MaliciousHook.sol` | Test hook verifying re-entry protection |
| `contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol` | Production hook for virtual account lifecycle |
