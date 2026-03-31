# Migration Script Usage

This document explains how to use the migration scripts for upgrading SYMMIO from v0.8.4 to v0.8.5.

## Overview

Migration is a two-step process:

1. **Prepare input** (`prepareMigrationInput.ts`) -- fetches open quotes and partyB balances from the subgraph, validates against on-chain state, writes a validated JSON file
2. **Run migration** (`runMigration.ts`) -- executes migration using the validated input, then verifies results on-chain

The low-level migration logic lives in `scripts/upgrade/migrate.ts`, which handles:
- Migrating quotes to populate aggregated positions
- Backfilling PartyA <-> PartyB connections for active positions (`connectedPartyBs` / `isConnectedPartyB`)
- Migrating partyB balances to the master bucket

Key features:
- **Automatic resume** - If interrupted, continues from where it left off
- **Retry with backoff** - Failed transactions are retried automatically
- **Dry run mode** - Test without executing transactions
- **Progress tracking** - Saves state to file after each operation
- **Post-migration verification** - Checks `isQuoteMigrated`, master balances, and aggregated positions

## Prerequisites

1. The system must be globally paused (by multisig or fork upgrade script)
2. The upgrade (diamondCut) must already be applied
3. The executor address must have `MIGRATION_ROLE` granted
4. `maxPartyAConnectionLimit` must be set (defaults to 0 after upgrade, which blocks `addConnection()`)

## Step 1: Prepare Migration Input

Fetches data from the subgraph, validates it against on-chain state, and writes a JSON file.

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost

# With custom subgraph endpoint
DIAMOND_ADDRESS=0x... SUBGRAPH_ENDPOINT=https://... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost
```

Output: `scripts/upgrade/output/migration-input.json`

### How validation works

- **Boundary check**: on-chain `getNextQuoteId()` must exceed the max subgraph quoteId
- **Quote spot-check**: random sample of quotes verified against `getQuote()` on-chain (status, partyA, partyB, symbolId)
- **Balance spot-check**: random sample of partyB allocated balances verified against `allocatedBalanceOfPartyB()` on-chain

### Env vars

| Env var | Default | Description |
|---------|---------|-------------|
| `DIAMOND_ADDRESS` | -- | Diamond proxy address (required) |
| `SUBGRAPH_ENDPOINT` | Goldsky stage | Subgraph GraphQL endpoint |
| `SPOT_CHECK_COUNT` | `20` | Number of quotes/balances to spot-check |
| `PREPARE_OUTPUT_FILE` | `scripts/upgrade/output/migration-input.json` | Output file path |

## Step 2: Run Migration

Takes the validated input file and runs migration + verification.

```bash
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
```

Output: `scripts/upgrade/output/migration-report.json`

### Configuration

Copy and edit the sample config:

```bash
cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate.json
```

| Field | Default | Description |
|-------|---------|-------------|
| `migrationInputFile` | -- | Path to validated input JSON (required) |
| `chunkSize` | `50` | Items per migration transaction (quotes and partyAs) |
| `dryRun` | `false` | Log operations without executing |
| `fork` | `false` | Impersonate diamond owner instead of using deployer signer |
| `progressFile` | `scripts/upgrade/output/migration-progress.json` | Resume file path |
| `reportFile` | `scripts/upgrade/output/migration-report.json` | Report file path |
| `outputDir` | `scripts/upgrade/output` | Output directory |
| `strict` | `false` | Stop immediately on any failure |

### Env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `MIGRATION_INPUT_FILE` | `migrationInputFile` |
| `MIGRATE_CHUNK_SIZE` | `chunkSize` |
| `DRY_RUN` | `dryRun` |
| `FORK` | `fork` |
| `MIGRATE_PROGRESS_FILE` | `progressFile` |
| `MIGRATE_REPORT_FILE` | `reportFile` |
| `MIGRATION_OUTPUT_DIR` | `outputDir` |
| `MIGRATE_STRICT` | `strict` |

## Low-Level API (`scripts/upgrade/migrate.ts`)

For programmatic use:

```typescript
import { migrate, MigrationInput } from "./migrate.js"

const input: MigrationInput = {
    quoteIds: [1n, 2n, 3n, ...],
    partyBTasks: [
        { partyB: "0x...", partyAs: ["0x...", "0x..."] },
        { partyB: "0x...", partyAs: ["0x..."] },
    ]
}

const report = await migrate(migrationFacet, input, {
    chunkSize: 50,
    maxRetries: 3,
    confirmations: 1,
})
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `chunkSize` | 50 | Items per transaction batch |
| `maxRetries` | 3 | Retry attempts for failed transactions |
| `retryDelayMs` | 2000 | Initial delay between retries (ms) |
| `retryBackoffMultiplier` | 2 | Exponential backoff multiplier |
| `confirmations` | 1 | Block confirmations to wait |
| `progressFile` | `./migration-progress.json` | Progress file path (null to disable) |
| `strict` | false | Throw error on any failure |
| `dryRun` | false | Log without executing transactions |

## Resume After Failure

The script automatically saves progress after each successful operation. If it fails (RPC error, timeout, etc.), simply run it again:

```bash
# First run - fails at chunk 5
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
# Output: error at chunk 5

# Second run - automatically resumes from chunk 5
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
# Output: Resuming migration from quotes phase
```

The progress file is automatically deleted when migration completes successfully.

## Dry Run

Test the migration without executing transactions:

```bash
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  DRY_RUN=true npx hardhat run scripts/upgrade/runMigration.ts --network localhost
```

## Migration Report

`migration-report.json` contains:

```json
{
  "status": "success",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 900000,
  "diamondAddress": "0x...",
  "migrationInputFile": "...",
  "input": {
    "quoteIdsTotal": 500,
    "partyBTasksTotal": 10,
    "aggregateKeys": 42
  },
  "verification": {
    "performed": true,
    "quoteChecks": 500,
    "partyBChecks": 10,
    "aggregateChecks": 42
  },
  "steps": [...]
}
```

## Post-Migration Verification

`runMigration.ts` automatically verifies after migration:
- **Quote migration**: checks `isQuoteMigrated()` for every quote ID
- **PartyB migration**: checks `isCrossLockedValuesMigrated()` and verifies master balance equals sum of per-partyA allocated balances
- **Aggregated positions**: if `expectedAggregates` are present in the input file, verifies `getPartyBAggregatedPositionBySymbolPerPartyA()` matches expected long/short amounts

## Troubleshooting

### "Already migrated" warnings
Normal if resuming -- the script checks on-chain state and skips completed work.

### Transaction failures
The script retries with exponential backoff. Check:
- RPC endpoint health
- Executor has sufficient gas
- Executor has `MIGRATION_ROLE`

### "PartyA max connection limit exceeded"
Quote migration calls `addConnection()` which checks `maxPartyAConnectionLimit`. This defaults to 0 after upgrade and must be set via `ControlFacet.setMaxPartyAConnectionLimit()` before migrating.

### Stuck migration
Delete the progress file (`scripts/upgrade/output/migration-progress.json`) to start fresh. Already-migrated items will be skipped via on-chain checks.

### Strict mode
Use `strict: true` in config (or `MIGRATE_STRICT=true` env var) to stop immediately on any failure instead of continuing.

### Subgraph validation fails
The subgraph may not be synced to the current block. Check the spot-check error message -- it tells you which field mismatched and whether the subgraph is stale.
