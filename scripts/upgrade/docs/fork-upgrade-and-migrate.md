# Fork Upgrade And Migration (v0.8.4 -> v0.8.5)

## How It Works

The upgrade is rehearsed against real mainnet state by forking the live chain. Three separate steps mirror the production flow: multisig upgrades, subgraph syncs, then migration runs.

- Forks the live chain state lazily (only fetches storage slots as accessed)
- Impersonates the real diamond owner via `hardhat_impersonateAccount`
- Uses subgraph for all data discovery (no slow on-chain scanning)
- Upgrade and migration are separate steps (mirrors production)
- No transactions touch the real network

`diamondCut` only changes executable code. Migration backfills and reshapes existing data so new v0.8.5 read/write paths have complete state. This separation lets you validate upgrade safety first, then execute migration in controlled batches with resume support.

## Prerequisites

- Running Hardhat fork node (Terminal 1)
- Subgraph endpoint (defaults to Goldsky Arbitrum stage)
- Config files:
  - Upgrade: `cp scripts/upgrade/config/upgrade.sample.json scripts/upgrade/config/upgrade.json`
  - Prepare migration: `cp scripts/upgrade/config/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json`
  - Migrate: `cp scripts/upgrade/config/migrate.sample.json scripts/upgrade/config/migrate.json`

## 1) Start Fork Node

Terminal 1:

```bash
npx hardhat node --network fork-arbitrum

# Or with a custom RPC:
FORK_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY npx hardhat node --network fork-arbitrum
```

## 2) Upgrade (diamondCut + Parameters)

Terminal 2:

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost
```

What it does:
- Reads diamond owner from LibDiamond storage
- Impersonates and funds the owner via `hardhat_impersonateAccount`
- Fetches party data from subgraph (no on-chain scanning)
- Grants admin roles, pauses the system
- Deploys v0.8.5 facets + libraries
- Builds and applies `diamondCut` in chunks
- Sets new parameters (`maxPartyAConnectionLimit`, `settlementCooldown`, `deallocateDebounceTime`)
- Spot-checks 20 quotes + 20 balances against subgraph to verify upgrade integrity
- Grants `MIGRATION_ROLE` for the next step

Output: `scripts/output/forkUpgrade-report.json`

## 3) Prepare Migration Input

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost
```

What it does:
- Fetches all open quotes (status 4, 6, 7) from the subgraph
- Fetches all PartyB-per-PartyA balance entries from the subgraph
- Validates a random sample against on-chain state (boundary check + spot-checks)
- Computes expected aggregated positions for post-migration verification
- Writes validated JSON input file

Output: `scripts/output/migration-input.json`

## 4) Migrate

```bash
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/output/migration-input.json \
  npx hardhat run scripts/upgrade/migrateOnDemand.ts --network localhost
```

What it does:
- Loads validated input file
- Runs `migrateQuotes()` in chunks (populates aggregated positions + connections)
- Runs `migrateCrossLockedValues()` per PartyB (builds master bucket)
- Verifies every quote is migrated, master balances match, aggregated positions are correct

Output: `scripts/output/migrateOnDemand-report.json`

## Configuration

Each step has its own config file under `scripts/upgrade/config/`.

### `upgrade.json` (Step 2: Upgrade)

| Field | Default | Description |
|-------|---------|-------------|
| `diamondAddress` | -- | Diamond proxy address |
| `adminAddress` | auto-resolved | Override for diamond owner |
| `diamondCutChunkSize` | `6` | Facet cuts per transaction |
| `subgraphEndpoint` | Goldsky stage | GraphQL endpoint |
| `spotCheckCount` | `20` | Pre/post upgrade integrity samples |
| `newV085Parameters.maxPartyAConnectionLimit` | -- | Required for migration |
| `newV085Parameters.settlementCooldown` | -- | Settlement cooldown seconds |
| `newV085Parameters.deallocateDebounceTime` | -- | Deallocation debounce seconds |

### `prepareMigration.json` (Step 3: Prepare Migration Input)

| Field | Default | Description |
|-------|---------|-------------|
| `diamondAddress` | -- | Diamond proxy address |
| `subgraphEndpoint` | Goldsky stage | GraphQL endpoint |
| `spotCheckCount` | `20` | Quote/balance spot-check samples |
| `outputDir` | `scripts/upgrade/output` | Output directory |
| `outputFile` | `scripts/upgrade/output/migration-input.json` | Output file path |

### `migrate.json` (Step 4: Migrate)

| Field | Default | Description |
|-------|---------|-------------|
| `diamondAddress` | -- | Diamond proxy address |
| `migrationInputFile` | -- | Path to validated input JSON |
| `chunkSize` | `50` | Quotes per migration transaction |
| `dryRun` | `false` | Log without executing |
| `strict` | `false` | Stop on any failure |
| `progressFile` | `scripts/upgrade/output/migration-progress.json` | Resume file path |
| `reportFile` | `scripts/upgrade/output/migrate-report.json` | Report file path |

## Verification

```bash
# Both should show "success"
jq '{status, error}' scripts/output/forkUpgrade-report.json
jq '{status, error}' scripts/output/migrateOnDemand-report.json
```

Key checks in `forkUpgrade-report.json`:
- `verify_upgrade` step is `ok` (subgraph data matches post-upgrade on-chain state)
- `grant_migration_role` step is `ok`

Key checks in `migrateOnDemand-report.json`:
- `verify_migration` step is `ok`
- All quotes migrated, master balances match, aggregated positions correct
