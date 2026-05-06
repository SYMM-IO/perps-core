# Liquidation Funding Snapshot Fix

## Summary

PartyA liquidation must settle positions using the same accounting snapshot that made the user liquidatable. Before this fix, liquidation prices were frozen at the Muon liquidation signature timestamp, but accumulated funding was recalculated later when `liquidatePositionsPartyA` was called. If a funding epoch passed between `liquidatePartyA` / `setSymbolsPrice` and position liquidation, the final settlement could include funding that was not part of the original liquidation proof.

The fix changes PartyA liquidation to calculate accumulated funding at the liquidation snapshot timestamp instead of the current block timestamp.

## Affected Flow

The affected normal PartyA liquidation flow was:

1. `liquidatePartyA(partyA, liquidationSig)`
2. `setSymbolsPrice(partyA, liquidationSig)`
3. Time passes and a funding epoch rolls over
4. `liquidatePendingPositionsPartyA(partyA)`
5. `liquidatePositionsPartyA(partyA, quoteIds)`
6. `settlePartyALiquidation(partyA, partyBs)`

The issue was in step 5. `liquidatePositionsPartyA` used the liquidation price stored from `liquidationSig`, but called `LibQuoteFunding.getAccumulatedFundingFee(quote.id)`, which calculated funding using `block.timestamp`.

## Why This Was Problematic

The liquidation proof includes PartyA uPNL and total unrealized loss at a specific timestamp. Once PartyA is tagged liquidated, normal funding charge calls are blocked by `notLiquidatedPartyA`, but the liquidation close path still included newly accrued funding indirectly through the view calculation.

That created a timestamp mismatch:

```text
Liquidation price: from liquidationSig.timestamp
Funding debt:      from liquidatePositionsPartyA block.timestamp
```

This could cause two bad outcomes:

1. **Unnecessary disputes.** If the extra funding changed PartyA's total accumulated uPNL, the liquidation would be marked disputed because `partyAAccumulatedUpnl != liquidationDetails.upnl`.
2. **Per-PartyB value shifts.** If funding deltas netted out at PartyA level, the PartyA-total dispute check could pass while settlement amounts between different PartyBs were still shifted.

The key invariant is that liquidation settlement should be based on one coherent snapshot. It should not depend on how quickly the liquidator closes positions after the user is already marked liquidated.

## Root Cause

`LibQuoteFunding.getAccumulatedFundingFee` was time-dependent:

```solidity
function getAccumulatedFundingFee(uint256 quoteId) public view returns (int256 fee)
```

Internally, it computed elapsed funding epochs using `block.timestamp`. That is correct for live views and normal funding charge flows, but not for a liquidation that has already frozen its insolvency timestamp.

`PartyALiquidationFacetImpl.liquidatePositionsPartyA` used that live helper when computing:

```solidity
pnlWithFunding = liquidationPricePnl - accumulatedFundingFee
```

So the amount could change just because an epoch passed before the liquidation close transaction was submitted.

## Fix Applied

### 1. Timestamp-aware epoch helpers

`LibFundingRate` now exposes timestamp-aware helpers:

```solidity
getEpochsSinceLastUpdateAt(fundingFee, timestamp)
getEpochsSinceStartAt(fundingFee, timestamp)
getEpochsSinceAt(fundingFee, fromTimestamp, toTimestamp)
```

The existing block-time helpers remain as wrappers around the new timestamp-aware versions, so normal funding views and charge flows keep their previous behavior.

### 2. Timestamp-aware quote funding calculation

`LibQuoteFunding` now exposes:

```solidity
getAccumulatedFundingFeeAt(quoteId, timestamp)
```

`getAccumulatedFundingFee(quoteId)` remains available and delegates to `getAccumulatedFundingFeeAt(quoteId, block.timestamp)`.

### 3. PartyA liquidation uses the liquidation snapshot

`PartyALiquidationFacetImpl.liquidatePositionsPartyA` now calculates funding with:

```solidity
LibQuoteFunding.getAccumulatedFundingFeeAt(quote.id, liquidationDetail.timestamp)
```

`liquidationDetail.timestamp` is set from the verified liquidation signature when PartyA is marked liquidated. This aligns funding with the same snapshot as the liquidation prices and signed uPNL.

## Expected Behavior After Fix

If an epoch passes after PartyA is marked liquidated but before `liquidatePositionsPartyA`, liquidation settlement should still use the funding debt as of the liquidation snapshot.

This means:

- The liquidation result does not depend on keeper timing across funding epoch boundaries.
- Funding accrued after the liquidation snapshot is not added to the liquidation settlement.
- The PartyA-total dispute check is no longer triggered solely because a funding epoch passed after liquidation tagging.
- Per-PartyB settlement is less exposed to hidden value shifts caused by post-snapshot funding accrual.

## Regression Test

The test suite now covers the exact race:

```text
Should use the liquidation funding snapshot when an epoch passes before closing positions
```

The test:

1. Opens a funded position.
2. Liquidates PartyA and sets liquidation prices.
3. Records funding debt at the liquidation point.
4. Advances time by another funding epoch.
5. Verifies live funding debt increased.
6. Liquidates pending and open positions.
7. Verifies the liquidation is not disputed and can settle.

This proves that post-tag epoch rollover no longer changes PartyA liquidation accounting.

## Files Changed

```text
contracts/core/libraries/LibFundingRate.sol
contracts/core/libraries/LibQuoteFunding.sol
contracts/core/facets/PartyALiquidation/PartyALiquidationFacetImpl.sol
test/LiquidationFacet.behavior.ts
```

## Verification

The fix was verified with:

```bash
npx hardhat test test/parallel/LiquidationFacet.test.ts
npx hardhat test test/parallel/FundingRate.test.ts test/parallel/AggregateViews.test.ts
```

Both the liquidation regression test and the broader funding / aggregate view suites passed.
