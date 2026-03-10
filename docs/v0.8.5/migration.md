# Migration Process

When upgrading from v0.8.4 to v0.8.5, existing data must be migrated to populate new storage structures. Two major features require this migration:

1. **Master Account Mode** - Unified balance management for partyBs across all partyAs
2. **Aggregated Positions** - O(symbols) UPNL and funding calculations instead of O(quotes)

## Why Migration is Needed

### Feature 1: Master Account Mode

In v0.8.4, partyB balances are tracked separately per partyA:

```solidity
// v0.8.4: Separate balances per partyA
partyBAllocatedBalances[partyB][partyA1] = 1000
partyBAllocatedBalances[partyB][partyA2] = 2000
partyBLockedBalances[partyB][partyA1] = {...}
partyBLockedBalances[partyB][partyA2] = {...}
```

This creates fragmentation - partyB cannot use excess balance from one partyA relationship to cover margin requirements for another.

**V0.8.5 Master Account Mode** introduces a unified "master bucket" keyed by `address(0)`:

```solidity
// v0.8.5: Master bucket aggregates all balances
partyBAllocatedBalances[partyB][address(0)] = 3000  // Total across all partyAs
partyBLockedBalances[partyB][address(0)] = {...}    // Total locked across all
```

When master account mode is enabled for a partyB, solvency checks use the master bucket, allowing unified capital management across all partyA relationships.

**Migration needed**: Sum existing per-partyA balances into the master bucket.

### Feature 2: Aggregated Positions for O(symbols) Calculations

In v0.8.4, calculating unrealized PnL (UPNL) and funding debt required iterating through every open quote. This O(n) complexity becomes a bottleneck as positions grow:

```solidity
// v0.8.4: Must iterate all quotes
for (uint256 i = 0; i < quotes.length; i++) {
    upnl += calculateQuotePnl(quotes[i], currentPrice);
}
```

**V0.8.5** introduces aggregated position structures that enable O(symbols) calculations:

```solidity
// v0.8.5: O(symbols) calculation
for (uint256 i = 0; i < activeSymbols.length; i++) {
    uint256 symbolId = activeSymbols[i];
    upnl += calculateSymbolPnl(aggregatedPositions[symbolId], currentPrice);
}
```

**Migration needed**: Populate aggregated positions from existing open quotes.

## What Gets Migrated

### 1. Aggregated Positions

Pre-computed position totals per symbol for efficient UPNL calculations:

```solidity
// Per partyB (global)
partyBAggregatedPositions[partyB][symbolId][positionType].aggregatedAmount
partyBAggregatedPositions[partyB][symbolId][positionType].aggregatedNotional

// Per partyB-partyA pair
partyBAggregatedPositionsPerPartyA[partyB][partyA][symbolId][positionType]
partyAAggregatedPositionsPerPartyB[partyA][partyB][symbolId][positionType]
```

### 2. Active Symbols Arrays

Lists of symbols with open positions for efficient iteration:

```solidity
partyBActiveSymbols[partyB][]                      // Global for partyB
partyBActiveSymbolsPerPartyA[partyB][partyA][]     // Per partyA
partyAActiveSymbolsPerPartyB[partyA][partyB][]     // Per partyB
```

### 3. Aggregate Funding

Pre-computed funding tracking for efficient funding debt calculations:

```solidity
partyAAggregatedFundingPerPartyB[partyA][partyB][symbolId][positionType].weightedPaidFunding
partyBAggregatedFunding[partyB][symbolId][positionType].weightedPaidFunding
partyBAggregatedFundingPerPartyA[partyB][partyA][symbolId][positionType].weightedPaidFunding
```

### 4. Quote Fields

New fields added to the Quote struct:

```solidity
quote.accumulatedPaidFunding  // Initialized based on current funding rates
quote.closeFee                // Remains 0 for existing quotes
quote.data                    // Remains empty for existing quotes
```

### 5. Master Account Locked Values

For partyBs that will operate in master account mode, balances must be aggregated into the master bucket (keyed by `address(0)`):

```solidity
// Allocated balances summed across all partyAs
partyBAllocatedBalances[partyB][address(0)] = sum of all partyA balances

// Locked balances summed across all partyAs
partyBLockedBalances[partyB][address(0)] = sum of all partyA locked values

// Pending locked balances summed across all partyAs
partyBPendingLockedBalances[partyB][address(0)] = sum of all partyA pending values
```

## Migration Components

### 1. MigrationFacet

The migration facet provides two main functions:

### `migrateQuotes(uint256[] quoteIds)`

Populates aggregated position and funding structures for existing quotes and backfills reserved open fee tracking for pending/locked quotes.

**What it does for each quote:**

- Skips if already migrated (idempotent)
- Skips non-existent quote IDs (detected by `partyA == address(0)`)
- For `PENDING`, `LOCKED`, or `CANCEL_PENDING` quotes:
  - Backfills `partyAReservedOpenFees` by calling `reserveOpenTradingFee` with the quote's open trading fee
  - This prevents a `balanceLimitPerUser` bypass where a user could allocate up to the cap, then cancel pending quotes to receive fee refunds that push the balance above the limit
- For `OPENED`, `CLOSE_PENDING`, or `CANCEL_CLOSE_PENDING` quotes:
  - Initializes `accumulatedPaidFunding` based on current funding rates
  - Adds to `partyBAggregatedPositions` and `partyAAggregatedPositions`
  - Updates `activeSymbols` arrays
  - Adds to aggregate funding structures

**Access Control:** Requires `MIGRATION_ROLE`

### `migrateCrossLockedValues(address partyB, address[] partyAs)`

Aggregates per-partyA balances into the master bucket for a partyB.

**What it does:**

- Sums `partyBAllocatedBalances[partyB][partyA]` → `partyBAllocatedBalances[partyB][address(0)]`
- Sums `partyBLockedBalances[partyB][partyA]` → `partyBLockedBalances[partyB][address(0)]`
- Sums `partyBPendingLockedBalances[partyB][partyA]` → `partyBPendingLockedBalances[partyB][address(0)]`
- Tracks migration per partyB+partyA pair -- already-migrated pairs are skipped
- Can be called in multiple batches if the partyAs array is too large for a single transaction

**Access Control:** Requires `MIGRATION_ROLE`

### 2. Verification Functions

```solidity
// Check if a specific quote has been migrated
function isQuoteMigrated(uint256 quoteId) external view returns (bool);

// Check if a specific partyB+partyA pair has been migrated to the cross bucket
function isCrossLockedValuesMigrated(address partyB, address partyA) external view returns (bool);
```

### 3. Master Account Mode Activation

After migration, master account mode can be enabled for any partyB:

```solidity
// In ControlFacet
function setPartyBMasterAccountMode(address partyB, bool enabled) external;
```

**Requirements:**

- Global `masterAccountEnabled` must be true
- Caller must have `MIGRATION_ROLE`
- Address must be a registered partyB

## Upgrade Process

### Step 1: Deploy New Facets

Perform a diamond cut to add/replace facets with v0.8.5 versions:

- MigrationFacet (new)
- Updated facets with aggregated position logic

### Step 2: Global Pause

Pause the entire system to prevent state changes during migration:

```solidity
controlFacet.setGlobalPaused(true);
```

### Step 3: Migrate Quotes

Migrate all active and pending quotes in batches:

```tsx
const BATCH_SIZE = 100;
const allQuoteIds = await getQuoteIdsToMigrate(); // From indexer/events

for (let i = 0; i < allQuoteIds.length; i += BATCH_SIZE) {
    const batch = allQuoteIds.slice(i, i + BATCH_SIZE);
    await migrationFacet.migrateQuotes(batch);
    console.log(`Migrated quotes ${i} to ${i + batch.length}`);
}
```

**Which quotes to migrate:**

- Status: `PENDING`, `LOCKED`, or `CANCEL_PENDING` -- backfills reserved open fee tracking to prevent `balanceLimitPerUser` bypass
- Status: `OPENED`, `CLOSE_PENDING`, or `CANCEL_CLOSE_PENDING` -- populates aggregated positions and funding structures

### Step 4: Migrate PartyB Balances

For each partyB, migrate their per-partyA balances to the master bucket. This can be done in batches if the partyAs array is too large for a single transaction:

```tsx
const BATCH_SIZE = 100;

for (const partyB of allPartyBs) {
    // Get all partyAs this partyB has relationships with
    const partyAs = await getPartyAsForPartyB(partyB);

    for (let i = 0; i < partyAs.length; i += BATCH_SIZE) {
        const batch = partyAs.slice(i, i + BATCH_SIZE);
        await migrationFacet.migrateCrossLockedValues(partyB, batch);
        console.log(`Migrated batch ${i / BATCH_SIZE + 1} for partyB: ${partyB}`);
    }
}
```

### Step 5: Unpause System

Resume normal operations:

```solidity
controlFacet.setGlobalPaused(false);
```

The upgrade is now complete. The system operates normally with the new aggregated position structures.

## Enabling Master Account Mode (Later)

Master account mode is a separate feature that can be enabled at any time after the upgrade.

### Enable Global Feature Flag

First, enable the master account feature globally:

```solidity
controlFacet.setMasterAccountEnabled(true);
```

### Enable Per PartyB

Individual partyBs can then opt-in to master account mode:

```solidity
controlFacet.setPartyBMasterAccountMode(partyB, true);
```

Once enabled for a partyB:

- Solvency checks use the master bucket instead of per-partyA values
- Allocations must go to `address(0)` instead of specific partyAs
- PartyB has unified capital across all partyA relationships

This can be done immediately after upgrade or months later - the migration ensures the master bucket data is ready whenever a partyB decides to enable it.

## Verification

After migration, verify correctness:

### 1. Quote Migration Status

```tsx
for (const quoteId of migratedQuoteIds) {
    const isMigrated = await migrationFacet.isQuoteMigrated(quoteId);
    assert(isMigrated, `Quote ${quoteId} not migrated`);
}
```

### 2. PartyB Balance Migration

```tsx
for (const partyB of allPartyBs) {
    const partyAs = await getPartyAsForPartyB(partyB);
    for (const partyA of partyAs) {
        const isMigrated = await migrationFacet.isCrossLockedValuesMigrated(partyB, partyA);
        assert(isMigrated, `PartyB ${partyB} + PartyA ${partyA} not migrated`);
    }
}
```

### 3. Master Bucket Correctness

```tsx
for (const partyB of allPartyBs) {
    const partyAs = await getPartyAsForPartyB(partyB);

    // Sum per-partyA values
    let expectedAllocated = 0n;
    for (const partyA of partyAs) {
        expectedAllocated += await viewFacet.allocatedBalanceOfPartyB(partyB, partyA);
    }

    // Compare to master bucket
    const masterBucket = await viewFacet.balanceInfoOfPartyBMasterAccount(partyB);
    assert(masterBucket.allocated === expectedAllocated);
}
```
