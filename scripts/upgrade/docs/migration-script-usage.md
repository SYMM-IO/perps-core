# Migration Script Usage

This document explains how to use the migration scripts for upgrading SYMMIO from v0.8.4 to v0.8.5.

## Overview

Migration is a three-step process:

1. **Prepare input** (`prepareMigrationInput.ts`) -- fetches open quotes and partyB balances from the subgraph, validates boundary against on-chain, writes a JSON file. **Can run before or after the diamondCut.**
2. **Validate input** (`validateMigrationInput.ts`) -- spot-checks migration input against on-chain state. Uses raw `eth_call` for `getQuote()` so it works on both v0.8.4 and v0.8.5 diamonds. **Optional but recommended.**
3. **Run migration** (`runMigration.ts`) -- executes migration using the validated input, then verifies results on-chain. **Requires v0.8.5 (after diamondCut).**

The low-level migration logic lives in `scripts/upgrade/migrate.ts`, which handles:

- Migrating quotes to populate aggregated positions
- Backfilling PartyA <-> PartyB connections for active positions (`connectedPartyBs` / `isConnectedPartyB`)
- Migrating partyB balances to the master bucket

Key features:

- **Automatic resume** - If interrupted, continues from where it left off
- **Retry with backoff** - Failed transactions are retried automatically
- **Dry run mode** - Test without executing transactions
- **RPC visibility** - Hardhat upgrade scripts that run the shared RPC check print the resolved network and RPC URL before chain checks
- **Progress tracking** - Saves state to file after each operation
- **Post-migration verification** - Checks `isQuoteMigrated`, master balances, and aggregated positions

## Prerequisites

**For `prepareMigrationInput.ts` and `validateMigrationInput.ts`:**

1. For the EOA/operator production path, prepare the migration input after pause so the migration data is based on paused state. Run it before migration and validate it; if validation reports drift, rerun preparation.
2. Diamond can be v0.8.4 or v0.8.5 — both scripts are version-agnostic

**For `runMigration.ts`:**

1. The upgrade (diamondCut) must already be applied (v0.8.5)
2. The configured `migrationRunner` must have `MIGRATION_ROLE` granted
3. `maxPartyAConnectionLimit` must be set (defaults to 0 after upgrade, which blocks `addConnection()`)
4. The system should be paused before executing migration transactions.

## Step 1: Prepare Migration Input

Fetches data from the subgraph, validates the boundary against on-chain `getNextQuoteId()` (which returns the last assigned ID, not next available), and writes a JSON file. Quote pagination uses `globalCounter` and filters open/migratable statuses locally to avoid slow subgraph `quoteStatus_in` queries. The open-quote fetch checkpoints each completed page, so rerunning the script resumes from the last saved globalCounter cursor if the subgraph fails mid-run. **Can run before or after the diamondCut** — no v0.8.5-specific ABIs are used.

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network mantle
```

Output: `scripts/upgrade/output/migration-input.json`

### Env vars

| Env var                   | Default                                                           | Description                                                               |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `DIAMOND_ADDRESS`         | from `upgrade.json`                                               | Diamond proxy address                                                     |
| `SUBGRAPH_ENDPOINT`       | from `upgrade.json`                                               | Subgraph GraphQL endpoint                                                 |
| `SUBGRAPH_ENDPOINTS`      | --                                                                | Comma-separated fallback subgraph endpoints tried before each retry wait  |
| `SUBGRAPH_PAGE_SIZE`      | `1000`                                                            | Subgraph pagination size. Use `500` or `250` if the endpoint returns 504. |
| `SUBGRAPH_MIN_PAGE_SIZE`  | `10`                                                              | Minimum page size for automatic retry page splitting                      |
| `SUBGRAPH_MAX_RETRIES`    | `5`                                                               | Number of retries per subgraph request before reducing page size/failing  |
| `SUBGRAPH_RETRY_DELAY_MS` | `2000`                                                            | Base retry delay in milliseconds                                          |
| `SUBGRAPH_TIMEOUT_MS`     | `60000`                                                           | Per-request timeout in milliseconds                                       |
| `SUBGRAPH_RESUME`         | `true`                                                            | Set to `false` to ignore an existing open-quotes progress file            |
| `SUBGRAPH_PROGRESS_FILE`  | `output/prepareMigrationInput-openQuotes-progress-{network}.json` | Open-quotes checkpoint file path                                          |
| `PREPARE_OUTPUT_FILE`     | `scripts/upgrade/output/migration-input.json`                     | Output file path                                                          |

The progress file is kept while later preparation steps run, then removed after `migration-input-{network}.json` is written successfully. Delete the progress file or set `SUBGRAPH_RESUME=false` to force a fresh subgraph scan.

## Step 1a: Fetch Symbol List

Fetches symbols from the configured subgraph and writes the input consumed by `setSymbolType.ts`.

```bash
USE_KEYSTORE=true RPC_BASE=https://base.drpc.org \
  npx hardhat run scripts/upgrade/fetchSymbolList.ts --network base
```

Dry run mode fetches and prints the symbols, prints the planned output path, and does not write the symbol input file:

```bash
DRY_RUN=true USE_KEYSTORE=true RPC_BASE=https://base.drpc.org \
  npx hardhat run scripts/upgrade/fetchSymbolList.ts --network base
```

| Env var                   | Default                                                 | Description                                       |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `SUBGRAPH_ENDPOINT`       | from `upgrade-{network}.json`                           | Subgraph GraphQL endpoint                         |
| `SYMBOL_TYPE`             | `newV085Parameters.symbolType` from `upgrade-{network}` | Symbol type to write for every fetched symbol     |
| `SYMBOL_TYPES_INPUT_FILE` | `output/{count}-symbol-types-input-{network}.json`      | Output path for the generated symbol input        |
| `DRY_RUN`                 | `false`                                                 | Fetch and print only; do not write the input file |

## Step 1b: Validate Migration Input (optional)

Two complementary scripts validate the migration input against on-chain state. Both use raw `eth_call` for `getQuote()` to work with v0.8.4 and v0.8.5. **Can run before or after the diamondCut.**

### `validateMigrationInput.ts` -- random spot-checks

Samples N random quotes and partyB balances to verify they exist on-chain. Good for catching systemic issues (wrong subgraph, stale data).

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/validateMigrationInput.ts --network mantle
```

What it checks:

- **Boundary**: max input quoteId must not exceed on-chain `getNextQuoteId()` (last assigned ID)
- **Quote spot-check**: random sample of quotes verified via raw `eth_call` + manual ABI decoding
- **Balance spot-check**: random sample of partyB allocated balances verified via `allocatedBalanceOfPartyB()`

| Env var                | Default                                       | Description                             |
| ---------------------- | --------------------------------------------- | --------------------------------------- |
| `DIAMOND_ADDRESS`      | from `upgrade.json`                           | Diamond proxy address                   |
| `MIGRATION_INPUT_FILE` | `scripts/upgrade/output/migration-input.json` | Input file to validate                  |
| `SPOT_CHECK_COUNT`     | `20`                                          | Number of quotes/balances to spot-check |

### `validateMigrationEdgeCases.ts` -- deterministic corner cases

Targets edge cases that random sampling is unlikely to hit. Especially important on fork tests where the subgraph indexes the live chain beyond the fork block.

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/validateMigrationEdgeCases.ts --network mantle
```

What it checks:

- **Boundary quote**: verifies the quote at `lastId` is included if it has a migratable status
- **Fork drift**: ensures no quoteIds exceed on-chain `lastId`
- **Gap scan**: scans first and last N quotes on-chain, flags active quotes missing from input
- **PartyB completeness**: checks for empty `partyAs` arrays and duplicate partyB entries
- **PENDING quotes**: samples PENDING quotes to verify zero-address partyB

| Env var                | Default                                       | Description                                          |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `DIAMOND_ADDRESS`      | from `upgrade.json`                           | Diamond proxy address                                |
| `MIGRATION_INPUT_FILE` | `scripts/upgrade/output/migration-input.json` | Input file to validate                               |
| `GAP_SCAN_RANGE`       | `50`                                          | Number of quotes to scan from each end (head + tail) |

## Step 2: Run Migration

Takes the validated input file and runs migration + verification. Any failure halts immediately. The migration report is always printed before exiting, even on failure.

On production networks, `runMigration.ts` resolves the signer from `upgrade-{network}.json` `migrationRunner`. Dry runs resolve the same signer for preflight checks, but still connect migration contracts with a provider-only runner so no transactions can be submitted. If that address is a hardware wallet or external wallet, expose it with `MIGRATION_RUNNER_RPC_URL` or the generic `HARDWARE_WALLET_RPC_URL`; direct Ledger scanning also works with `HW_WALLET=ledger LEDGER_SCAN=true` or a known `LEDGER_PATH`.

Before migration execution, the script checks that the resolved signer has `MIGRATION_ROLE` on the diamond. In dry-run mode, a missing role is reported as a warning and the dry run continues. In execution mode, a missing role fails early. To bypass only this preflight in execution mode, set `SKIP_MIGRATION_ROLE_CHECK=true`.

`setSymbolType.ts` does the same style of preflight for `SYMBOL_MANAGER_ROLE`. In dry-run mode it checks the configured `migrationRunner` address, prints the result in the terminal summary, and continues if missing. In execution mode, the resolved signer must have the role unless `SKIP_SYMBOL_MANAGER_ROLE_CHECK=true` is set.

`whitelistSymbolTypes.ts` also preflights `PARTY_B_MANAGER_ROLE` for the configured `WHITELIST_SIGNER_ROLE`. In dry-run mode it checks the configured signer address, writes a dry-run report, prints the role result in the terminal summary, and continues if missing. In execution mode, the signer must have `PARTY_B_MANAGER_ROLE` unless `SKIP_PARTY_B_MANAGER_ROLE_CHECK=true` is set.

Built-in verification (step 4/4) checks:

- `isQuoteMigrated()` for every quoteId — quotes with non-migratable on-chain status (CANCELED, CLOSED, etc.) are skipped, matching the contract's behavior
- `isCrossLockedValuesMigrated()` for every partyB-partyA pair
- Cross locked values sum matches per-partyA values
- Aggregated positions match expected amounts from the input

```bash
USE_KEYSTORE=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
```

Output: `scripts/upgrade/output/migration-report.json`

### Configuration

Copy and edit the sample config:

```bash
cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate.json
```

| Field                | Default                                          | Description                                                                                      |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `migrationInputFile` | --                                               | Path to validated input JSON (required)                                                          |
| `chunkSize`          | `50`                                             | Items per migration transaction (quotes and partyAs)                                             |
| `dryRun`             | `false`                                          | Log operations without executing                                                                 |
| `fork`               | `false`                                          | Impersonate diamond owner instead of using deployer signer                                       |
| `skipPreCheck`       | `false`                                          | Skip on-chain pre-flight checks for already-migrated items (faster, may send no-op transactions) |
| `progressFile`       | `scripts/upgrade/output/migration-progress.json` | Resume file path                                                                                 |
| `reportFile`         | `scripts/upgrade/output/migration-report.json`   | Report file path                                                                                 |
| `outputDir`          | `scripts/upgrade/output`                         | Output directory                                                                                 |

### Env var overrides

| Env var                                                 | Overrides                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DIAMOND_ADDRESS`                                       | `diamondAddress`                                                                   |
| `MIGRATION_INPUT_FILE`                                  | `migrationInputFile`                                                               |
| `MIGRATION_RUNNER_RPC_URL`                              | Role-specific external wallet RPC for the configured `migrationRunner` signer      |
| `HARDWARE_WALLET_RPC_URL` / `HW_WALLET_RPC_URL`         | Generic external wallet RPC fallback for hardware-wallet signers                   |
| `HW_WALLET=ledger` / `LEDGER_SCAN=true` / `LEDGER_PATH` | Direct Ledger signer discovery when no external wallet RPC is used                 |
| `MIGRATE_CHUNK_SIZE`                                    | `chunkSize`                                                                        |
| `DRY_RUN`                                               | `dryRun`                                                                           |
| `FORK`                                                  | `fork`                                                                             |
| `SKIP_PRE_CHECK`                                        | `skipPreCheck`                                                                     |
| `SKIP_MIGRATION_ROLE_CHECK`                             | Skip the signer `MIGRATION_ROLE` preflight                                         |
| `MIGRATION_GAS_LIMIT` / `MIGRATE_GAS_LIMIT`             | Explicit gas limit for migration transactions; falls back to `TX_GAS_LIMIT`        |
| `SET_SYMBOL_TYPES_GAS_LIMIT` / `SYMBOL_TYPES_GAS_LIMIT` | Explicit gas limit for `setSymbolTypes` transactions; falls back to `TX_GAS_LIMIT` |
| `WHITELIST_SIGNER_ROLE`                                 | Signer for `whitelistSymbolTypes.ts`; defaults to `upgradeOperator`                |
| `SKIP_SYMBOL_MANAGER_ROLE_CHECK`                        | Skip the `SYMBOL_MANAGER_ROLE` preflight in `setSymbolType.ts`                     |
| `SKIP_PARTY_B_MANAGER_ROLE_CHECK`                       | Skip the `PARTY_B_MANAGER_ROLE` preflight in `whitelistSymbolTypes.ts`             |
| `MIGRATE_PROGRESS_FILE`                                 | `progressFile`                                                                     |
| `MIGRATE_REPORT_FILE`                                   | `reportFile`                                                                       |
| `MIGRATION_OUTPUT_DIR`                                  | `outputDir`                                                                        |

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

const report = await migrate(migrationFacet, viewFacetQuote, input, {
    chunkSize: 50,
    maxRetries: 3,
    confirmations: 1,
})
```

### Configuration Options

| Option                   | Default                     | Description                                                            |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------- |
| `chunkSize`              | 50                          | Items per transaction batch                                            |
| `maxRetries`             | 3                           | Retry attempts for failed transactions                                 |
| `retryDelayMs`           | 2000                        | Initial delay between retries (ms)                                     |
| `retryBackoffMultiplier` | 2                           | Exponential backoff multiplier                                         |
| `confirmations`          | 1                           | Block confirmations to wait                                            |
| `progressFile`           | `./migration-progress.json` | Progress file path (null to disable)                                   |
| `skipPreCheck`           | false                       | Skip on-chain pre-flight checks (faster, contract handles idempotency) |
| `dryRun`                 | false                       | Log without executing transactions                                     |

## Resume After Failure

The script automatically saves progress after each successful operation. If it fails (RPC error, timeout, etc.), simply run it again:

```bash
# First run - fails at chunk 5
USE_KEYSTORE=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
# Output: error at chunk 5

# Second run - automatically resumes from chunk 5
USE_KEYSTORE=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
# Output: Resuming migration from quotes phase
```

The progress file is automatically deleted when migration completes successfully.

## Dry Run

Test the migration without executing transactions:

```bash
USE_KEYSTORE=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  DRY_RUN=true npx hardhat run scripts/upgrade/runMigration.ts --network localhost
```

Live BSC dry run with signer role preflight:

```bash
DRY_RUN=true USE_KEYSTORE=true RPC_BSC=https://bsc-rpc.publicnode.com \
  npx hardhat run scripts/upgrade/runMigration.ts --network bsc
```

Symbol helper dry runs:

```bash
# Fetch and print symbols without writing the symbol input file.
DRY_RUN=true USE_KEYSTORE=true RPC_BASE=https://base.drpc.org \
  npx hardhat run scripts/upgrade/fetchSymbolList.ts --network base

# Preview setSymbolType transactions without submitting.
DRY_RUN=true USE_KEYSTORE=true RPC_BASE=https://base.drpc.org \
  npx hardhat run scripts/upgrade/setSymbolType.ts --network base

# Preview PartyB symbol-type whitelisting without submitting.
DRY_RUN=true USE_KEYSTORE=true RPC_BASE=https://base.drpc.org \
  npx hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network base
```

These Hardhat scripts print `Network` and `RPC URL` before the chain/block check. URL username, password, and query strings are masked in the log output.

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

### Subgraph validation fails

The subgraph may not be synced to the current block. Check the spot-check error message -- it tells you which field mismatched and whether the subgraph is stale.
