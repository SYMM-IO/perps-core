# Accumulated Funding Rate

In perpetual futures markets, funding fees are the mechanism that keeps the perpetual price aligned with the spot (underlying) price. At fixed intervals (for example, every 8 hours), one side of the market (long or short) pays the other. Each interval is called an epoch.

## The Original System and Its Challenges

Previously, our market makers (partyBs) could charge funding per quote in every epoch. The mechanism was simple: when it was time to charge funding, the system would adjust the `openPrice` of each position to reflect the funding paid or received. If a long position paid funding, we'd increase their open price, effectively giving them a worse entry point. If they received funding, we'd decrease it, improving their position.

This approach was intuitive and worked well initially. However, as our platform grew, we discovered a critical problem: market makers had to batch-process funding charges for every single position at each epoch. Imagine having 500 open positions and needing to process each one every 8 hours. Although they could batch for example 50 quotes per tx but even that was still inefficient.

But there was another, more subtle issue. The old system required funding to be charged exactly at epoch boundaries. Miss that window, and you'd have to wait for the next epoch. This rigidity didn't align well with the dynamic nature of our markets.

## The New Design: Thinking in Averages

We realized we needed to fundamentally rethink our approach. Instead of processing each position individually at every epoch, what if we could track funding rates at the symbol level and calculate what each position owes when we actually need to?

This led us to adopt an **accumulated weighted average system**. The core insight is elegant: we don't need to store a history of rates or process positions in real-time. Instead, we maintain **the average so far** and **the current value**. Whenever time advances, we update the average by mixing in the current value for the new epochs.

Think of it like calculating your semester GPA. You don't recalculate from scratch each time - you take your existing GPA (weighted by credit hours so far) and blend in your new grades (weighted by new credit hours). The math maintains perfect accuracy while being computationally efficient.

## How the Accumulated System Works

Each (symbol, market maker) pair now has its own `FundingFee` structure that tracks everything we need:

```solidity
struct FundingFee {
    int256 currentLongRate;       // Current rate for longs
    int256 currentShortRate;      // Current rate for shorts
    int256 accumulatedLongRate;  // Average rate for longs over time
    int256 accumulatedShortRate; // Average rate for shorts over time
    uint256 lastUpdatedEpoch;    // When we last updated
    uint256 startEpoch;          // When tracking began
    uint256 epochDuration;       // How long each epoch is
    int256 snapshotLongFee;     // Frozen cumulative long fee from previous durations
    int256 snapshotShortFee;    // Frozen cumulative short fee from previous durations
}
```

When a market maker sets a new funding rate, we don't immediately charge all positions. Instead, we update our weighted average. The calculation is straightforward:

Let's say we've been tracking for 2 epochs at 0.05%, and now we're setting a new rate of 0.03% that will apply for the next 3 epochs. Our new average becomes: `(0.05% × 2 + 0.03% × 3) / 5 = 0.038%`

This average represents the effective rate over all 5 epochs. When we eventually charge a position, we can calculate exactly what they owe based on how long they've been open and what rates were in effect during that time.

## A Clever Optimization: Price-Adjusted Rates

Funding fees depend on both the rate and the market price. Normally, you'd calculate: `fee = position size × market price × funding rate`. This means fetching and multiplying by the market price every time you calculate fees.

We made an optimization here. When setting funding rates, we pre-multiply them by the market price:

```solidity
storedRate = (percentageRate * marketPrice) / 1e18
```

Now when calculating fees, we simply multiply the stored rate by position size. No need to fetch or pass in prices again. It's a small change that significantly reduces gas costs and complexity.

## Tracking What's Been Paid

For each position (quote), we track two critical pieces of information:

```solidity
struct Quote {
    // ... other fields ...
    uint256 lastFundingPaymentTimestamp;  // When we last charged funding
    int256 accumulatedPaidFunding;        // The accumulated rate at last payment
}
```

When charging funding, we calculate the total accumulated funding since the position opened, then subtract what was already paid. This ensures we never double-charge and can accurately handle positions that have been open for varying periods.

## Handling Dynamic Epoch Durations

Markets evolve, and sometimes a market maker might want to change their funding frequency from, say, 8-hour epochs to 1-hour epochs. Our system handles this using a **snapshot approach** that preserves fee accuracy across duration changes.

### The Problem with Re-dividing Timestamps

The total accumulated fee at any point is: `accumulatedRate × epochCount`, where `epochCount = floor(lastUpdatedTimestamp / duration) - floor(startTimestamp / duration)`.

A naive approach to changing duration would re-divide the old timestamps by the new duration to get a new epoch count, then scale the rate to compensate. But floor division doesn't distribute cleanly -- `floor(a/d₁)` and `floor(a/d₂)` can round independently, so the re-divided epoch count can be off by up to 1 on each end. This means parties could be overcharged or undercharged by up to 2 epochs of fees.

### The Snapshot Solution

Instead of re-measuring old history with a new ruler, we **freeze the old total and start fresh**:

1. **Read the odometer.** Calculate the exact cumulative fee under the old duration: `snapshot = accumulatedRate × (lastUpdatedEpoch - startEpoch)`. This is a single scalar -- no division, no rounding error.

2. **Store it.** Add this value to `snapshotLongFee` / `snapshotShortFee` in the `FundingFee` struct. These fields accumulate across multiple duration changes.

3. **Reset the odometer.** Set `startEpoch` and `startEpochTimeStamp` to the current time. The weighted average (`accumulatedRate`) resets to `currentRate`. Epoch tracking begins from zero under the new duration.

4. **Scale only the current rate.** The `currentRate` is scaled by `newDuration / oldDuration` so the per-second economic impact stays the same. A 0.04% rate per 8 hours becomes 0.005% per hour.

From this point on, the total fee is always:

```
totalFee = snapshotFee + accumulatedRate × epochsSinceStart + currentRate × epochsSinceLastUpdate
```

The snapshot captures all history as an exact number. The new tracking runs cleanly under the new duration. The two pieces simply add together. If the duration changes again, the current tracking gets folded into the snapshot and the process repeats -- snapshots compose without compounding any error.

This flexibility is crucial for market makers who need to adapt to changing market conditions. During volatile periods, they might want more frequent funding updates. During stable periods, less frequent updates save on gas costs.

## Aggregate Funding Tracking for Efficient UPNL Calculations

As positions accumulate, calculating total funding debt becomes expensive. A naive approach would iterate through every open quote - O(quotes) complexity. With thousands of positions, this becomes prohibitively expensive for on-chain computation, especially when calculating unrealized PnL for solvency checks.

We solved this with aggregate funding tracking. The key mathematical insight is that for quotes sharing the same (partyA, partyB, symbolId, positionType):

```solidity
Total Funding = Σ [openAmount_i × (currentFee - accumulatedPaidFunding_i)] / 1e18
= currentFee × Σ(openAmount_i) / 1e18 - Σ(openAmount_i × accumulatedPaidFunding_i) / 1e18
= currentFee × totalOpenAmount / 1e18 - totalWeightedPaidFunding / 1e18
```

By maintaining totalWeightedPaidFunding = Σ(openAmount × accumulatedPaidFunding), we can calculate total funding debt in O(symbols) instead of O(quotes). This is tracked in the PartiesAggregatedFunding structure:

```solidity
struct PartiesAggregatedFunding {
	int256 weightedPaidFunding; // Σ(openAmount × accumulatedPaidFunding / 1e18)
}
```

The aggregate is updated incrementally whenever:

- A position is opened (add contribution)
- A position is closed (subtract contribution)
- Funding is charged (update the paid funding component)

This enables efficient aggregate views like getPartyAAggregateFundingDebt() and getPartyBGlobalAggregateFundingDebt() that return accurate funding obligations without iterating through individual positions. We will see later in the docs on how to calculate UPNL with newly added methods.

## Future Enhancement: Funding Rate Caps

The Quote struct includes a maxFundingRate field that would allow traders to specify the maximum funding rate they're willing to accept on a position. This feature is designed to protect traders from unexpectedly high funding charges during extreme market conditions.

However, implementing funding caps properly with the aggregated funding system adds complexity. With caps, the aggregate calculations would need to account for per-quote rate limits, which would reduce the efficiency gains of the aggregation approach.

This feature is postponed to a later version. The field is kept in the struct for forward compatibility, but is currently set to a placeholder value and not enforced. When implemented, this will allow traders to set protective limits while we develop an efficient approach that preserves the O(symbols) calculation benefits.

# The Settlement Revolution

Perhaps the most significant change is how we settle funding fees. In the previous version, we adjusted the quote's `openPrice` to reflect funding. This was a clever workaround but had limitations.

The main issue was that we couldn't directly charge a user's allocated balance. Why? Because a user might have a large unrealized profit but a small allocated balance. If we tried to deduct funding from their allocated balance, it might go negative even though their total position value was strongly positive.

Now, with our `settleUpnl` functionality, we can realize portions of unrealized PnL when needed. This allows us to directly deduct funding from allocated balances, making the entire process more transparent and intuitive. Users see funding as a clear line item rather than a mysterious price adjustment.

We enforce maximum funding rates at the position level. Even if market rates spike, a position's funding fee per epoch cannot exceed the cap set when the position was opened. This protects traders from extreme market conditions.

After charging funding, we verify that both parties remain solvent. The funding transfer cannot cause either party's available balance to go negative, ensuring the system remains economically sound.

## Migration Philosophy

We designed the migration to be gradual and safe. The old and new systems can coexist, with each (symbol, market maker) pair using one or the other. The system automatically detects which method is active and prevents mixing.

When a market maker decides to migrate a symbol, they first charge all pending funding under the old system, ensuring no fees are lost. Then they set an epoch duration for that symbol, which activates the new accumulated system. From that point forward, funding accumulates under the new mechanism.

This approach allows market makers to migrate at their own pace, testing with less critical symbols first and moving to higher-volume symbols once they're comfortable with the new system.

## Update UPNL Calculations

As we update the funding fee calculation, now we have an accumulated funding fee that party A should pay to party B or vice versa. So we now add this parameter to UPnL calculation. Because of this update, we updated the method `liquidatePartyAPositions` where party A accumulated upnl and settlement amounts are calculated.

To find the accumulated funding fee for a list of quotes, we have this view call function :

```solidity
function getSumAccumulatedFundingFees(uint256[] memory quoteIds) external view returns (int256)
```
