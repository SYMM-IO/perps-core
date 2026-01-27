# Migration Script Usage

This document explains how to use the migration script for upgrading SYMMIO from v0.8.4 to v0.8.5.

## Overview

The migration script (`scripts/migrate.ts`) handles:
- Migrating quotes to populate aggregated positions
- Migrating partyB balances to the master bucket

Key features:
- **Automatic resume** - If interrupted, continues from where it left off
- **Retry with backoff** - Failed transactions are retried automatically
- **Dry run mode** - Test without executing transactions
- **Progress tracking** - Saves state to file after each operation

## Prerequisites

1. Collect migration data from your indexer:
   - All open quote IDs (status: OPENED, CLOSE_PENDING, CANCEL_CLOSE_PENDING)
   - All partyB addresses with their associated partyAs

2. Ensure the executor address has `MIGRATION_ROLE`

3. The system should be globally paused during migration

## Configuration

Create a `.env` file or set environment variables:

```bash
RPC_URL=https://your-rpc-endpoint
PRIVATE_KEY=your-migration-executor-private-key
DIAMOND_ADDRESS=0x-your-diamond-address
DRY_RUN=false
```

## Basic Usage

```typescript
import { ethers } from "ethers"
import { MigrationFacet__factory } from "../src/types/index.js"
import { migrate, MigrationInput } from "./migrate.js"

const provider = new ethers.JsonRpcProvider(RPC_URL)
const signer = new ethers.Wallet(PRIVATE_KEY, provider)
const migrationFacet = MigrationFacet__factory.connect(DIAMOND_ADDRESS, signer)

const input: MigrationInput = {
    quoteIds: [1n, 2n, 3n, ...],  // From your indexer
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

## Configuration Options

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
npx ts-node scripts/migrate-example.ts
# Output: ✗ Migrate quotes (chunk 5/10) - connection timeout

# Second run - automatically resumes from chunk 5
npx ts-node scripts/migrate-example.ts
# Output: Resuming migration from quotes phase
#         Quotes processed: 200
```

Progress is tracked in `migration-progress.json`:
```json
{
  "startedAt": "2024-01-27T10:00:00.000Z",
  "phase": "quotes",
  "quotesProcessed": 200,
  "partyBsProcessed": 0,
  "lastProcessedQuoteChunk": 4,
  "lastProcessedPartyB": -1
}
```

The file is automatically deleted when migration completes successfully.

## Dry Run

Test the migration without executing transactions:

```bash
DRY_RUN=true npx ts-node scripts/migrate-example.ts
```

Or in code:
```typescript
await migrate(migrationFacet, input, { dryRun: true })
```

## Migration Report

The script returns a detailed report:

```typescript
{
  startedAt: "2024-01-27T10:00:00.000Z",
  finishedAt: "2024-01-27T10:15:00.000Z",
  totalDuration: 900000,
  quotesTotal: 500,
  quotesMigrated: 500,
  partyBsTotal: 10,
  partyBsMigrated: 10,
  operations: [...],
  status: "success" | "partial_failure" | "failed"
}
```

## Collecting Migration Data

Example of collecting data from a subgraph:

```typescript
async function collectQuoteIds(): Promise<bigint[]> {
    const query = `
        query {
            quotes(where: {
                quoteStatus_in: ["OPENED", "CLOSE_PENDING", "CANCEL_CLOSE_PENDING"]
            }) {
                id
            }
        }
    `
    const result = await fetch(SUBGRAPH_URL, {
        method: "POST",
        body: JSON.stringify({ query })
    }).then(r => r.json())

    return result.data.quotes.map(q => BigInt(q.id))
}

async function collectPartyBTasks(): Promise<PartyBMigrationTask[]> {
    const query = `
        query {
            partyBs {
                id
                quotes(where: {
                    quoteStatus_in: ["OPENED", "CLOSE_PENDING", "CANCEL_CLOSE_PENDING"]
                }) {
                    partyA { id }
                }
            }
        }
    `
    const result = await fetch(SUBGRAPH_URL, {
        method: "POST",
        body: JSON.stringify({ query })
    }).then(r => r.json())

    return result.data.partyBs.map(pb => ({
        partyB: pb.id,
        partyAs: [...new Set(pb.quotes.map(q => q.partyA.id))]
    }))
}
```

## Troubleshooting

### "Already migrated" warnings
Normal if resuming - the script checks on-chain state and skips completed work.

### Transaction failures
The script retries with exponential backoff. Check:
- RPC endpoint health
- Executor has sufficient gas
- Executor has `MIGRATION_ROLE`

### Stuck migration
Delete `migration-progress.json` to start fresh (already-migrated items will be skipped via on-chain checks).

### Strict mode
Use `strict: true` to stop immediately on any failure instead of continuing:
```typescript
await migrate(migrationFacet, input, { strict: true })
```
