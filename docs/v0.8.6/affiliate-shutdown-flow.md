# Affiliate Shutdown Flow

Version: v0.8.6.

This flow gives frontends a cleaner way to shut down without leaving open positions unmanaged.

Before this change, a frontend could be deregistered, but deregistration only stopped new affiliate relationships. It did not give the frontend a clear shutdown process for its existing positions. The protocol now supports an explicit shutdown schedule: once a frontend announces a shutdown date, new positions through that frontend stop immediately, solvers get a window to close the existing positions, and the Clearing House can close anything that remains after the selected date.

## Why We Added This

A frontend shutdown has two competing needs:

- Users should not keep opening fresh positions through a frontend that is leaving.
- Existing positions should not be forced closed immediately if solvers can close them normally first.

The shutdown flow separates those concerns. Scheduling a shutdown makes the frontend close-only right away, but it still leaves time for normal close flows and solver-driven emergency closes before the Clearing House steps in.

This gives the frontend a predictable exit path, gives solvers a clear deadline, and gives the protocol a final mechanism if positions are still open when the deadline arrives.

## Flow

```text
1. Frontend / affiliate chooses a shutdown timestamp.
2. Affiliate or AFFILIATE_MANAGER_ROLE schedules that timestamp on-chain.
3. The frontend becomes close-only immediately.
4. Users and solvers can keep closing existing positions.
5. PartyB can use emergencyClosePosition for quotes of that affiliate.
6. After the shutdown timestamp, Clearing House can close any remaining affiliate positions.
```

The protocol does not decide the notice period. The frontend chooses the timestamp, and the contract only requires it to be nonzero.

If the shutdown plan changes, the affiliate or affiliate manager can cancel the shutdown. The timestamp cannot be edited in place; changing the date means cancelling the current schedule and creating a new one.

## Scheduled State

The scheduled timestamp is stored per affiliate:

```solidity
mapping(address => uint256) affiliateShutdownTime;
```

`0` means no shutdown is scheduled. Any nonzero timestamp means the affiliate is in shutdown mode.

Two views expose this state:

```solidity
function isAffiliateShutdownScheduled(address affiliate) external view returns (bool isScheduled);
function getAffiliateShutdownTime(address affiliate) external view returns (uint256 shutdownTime);
```

## What Close-Only Means

Close-only means no new position can be opened through the affiliate once shutdown is scheduled.

This blocks the full opening pipeline:

- users cannot send new quotes with the affiliate
- PartyB cannot lock pending quotes for that affiliate
- PartyB cannot open locked quotes for that affiliate
- batch open rejects quotes for that affiliate

Closing remains available. The goal is not to freeze the frontend's users; it is to prevent new exposure while existing exposure is wound down.

## Solver Window

During the shutdown window, the existing `emergencyClosePosition` path can be used for quotes that belong to the shutting-down affiliate.

This is scoped by quote affiliate. Scheduling one affiliate does not enable emergency close for unrelated affiliate quotes, and it does not activate global emergency mode.

The reason for reusing `emergencyClosePosition` is that it already has the close semantics we need: PartyB closes its own quote using signed UPNL and price data, while the normal solvency and quote-status checks still apply.

## Clearing House Backstop

If positions remain after the shutdown timestamp, Clearing House can call:

```solidity
function closeAffiliatePositions(
    address affiliate,
    uint256[] memory quoteIds,
    uint256[] memory prices
) external;
```

This is the final backstop in the flow. It is only available after the scheduled timestamp and only for quotes that belong to the scheduled affiliate.

The close uses normal close accounting. It is not a liquidation path, so it avoids positions that are already inside PartyA or PartyB liquidation flows.

## End State

After all positions are closed, the affiliate can be treated as fully shut down from an operations point of view. If the shutdown is cancelled before that, opening through the affiliate becomes available again, assuming the affiliate is still active and the usual protocol checks pass.
