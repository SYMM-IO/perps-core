# Production Upgrade (v0.8.4 -> v0.8.5)

## Overview

The production upgrade flow depends on whether the diamond is owned by an EOA or a multisig (Gnosis Safe).

**EOA path (single script):**

1. **Upgrade** (`eoaUpgrade.ts`) -- deploy facets, pause, diamondCut, set v0.8.5 parameters, deploy AccountLayer + InstantLayer, wire integrations, grant migration role
2. **Prepare migration input** (`prepareMigrationInput.ts`) -- fetch data from subgraph, validate against on-chain
3. **Run migration** (`runMigration.ts`) -- execute migration + verify
4. **Post-migration** (`generatePostMigrationTxs.ts`) -- unpause, enable cross-PartyB mode

**EOA path (step-by-step):**

1. **Deploy facets** (`deployFacets.ts`) -- deploy v0.8.5 facets + libraries to the target network
2. **Apply upgrade** (`applyUpgrade.ts`) -- build and execute a single diamondCut transaction
3. **Prepare migration input** (`prepareMigrationInput.ts`) -- fetch data from subgraph, validate against on-chain
4. **Run migration** (`runMigration.ts`) -- execute migration + verify
5. **Post-migration** (`generatePostMigrationTxs.ts`) -- unpause, enable cross-PartyB mode

**Safe path:**

1. **Deploy facets** (`deployFacets.ts`) -- deploy v0.8.5 facets + libraries to the target network
2. **Deploy AccountLayer + InstantLayer** -- deploy separately, provide addresses in config
3. **Generate Safe transactions** (`generateSafeUpgradeTxs.ts`) -- build Safe Transaction Builder JSON (includes AL/IL wiring)
4. **Execute upgrade** -- submit via Safe UI
5. **Prepare migration input** (`prepareMigrationInput.ts`) -- fetch data from subgraph, validate against on-chain
6. **Run migration** (`runMigration.ts`) -- execute migration + verify
7. **Post-migration** (`generatePostMigrationTxs.ts`) -- unpause, enable cross-PartyB mode

## Prerequisites

- Diamond address on the target network
- Admin account (EOA with diamond ownership, or Safe multisig)
- Subgraph endpoint synced to current chain state (for migration)
- Config file:
  ```bash
  cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade.json
  # edit scripts/upgrade/config/upgrade.json
  ```

## Testing

Before running the upgrade in production, test the full flow on localhost:

1. Deploy v0.8.4 from the previous codebase to a local Hardhat node
2. Run `eoaUpgrade.ts --network localhost` against it
3. Run `verifyUpgrade.ts --network localhost` to confirm on-chain state matches `deployed-facets.json`

```bash
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network localhost

# Verify on-chain diamond state matches deployed-facets.json (localhost only)
npx hardhat run scripts/upgrade/verifyUpgrade.ts --network localhost
```

`verifyUpgrade.ts` is a localhost testing tool -- it is not part of the production upgrade flow. Use it to validate the diamond cut before going to production.

## EOA: Single Script Upgrade

For EOA-owned diamonds, `eoaUpgrade.ts` runs the full upgrade in one command: deploys facets, pauses the system, applies the diamond cut, sets v0.8.5 parameters, deploys AccountLayer + InstantLayer, wires integrations, and grants the migration role.

```bash
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

# Override diamond address
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum
```

What it does (in order):

| Step | Action |
|------|--------|
| 1 | Deploy v0.8.5 libraries + facets (resume-safe via `deployed-facets.json`) |
| 2 | Build diamond cut (diff current vs new selectors) |
| 3 | `setAdmin` + grant `PAUSER_ROLE`/`UNPAUSER_ROLE` + `pauseGlobal()` |
| 4 | Apply diamond cut (single transaction) |
| 5 | Set new v0.8.5 parameters from config (`newV085Parameters`) |
| 6 | Deploy AccountLayer Diamond + InstantLayer, wire integrations, setup templates |
| 7 | Grant `MIGRATION_ROLE` to configured `migrationRunner` |

After completion, the system is paused and ready for migration. Continue with [Step 3: Prepare Migration Input](#step-3-prepare-migration-input).

Output:
- `scripts/upgrade/output/deployed-facets.json` -- deployed facet addresses
- `scripts/upgrade/output/deployed-accountlayer-instantlayer.json` -- AccountLayer + InstantLayer addresses

---

## Step-by-Step Scripts

The steps below can be used individually (e.g. for Safe path, or if you need more control over the EOA upgrade process).

## Step 1: Deploy Facets

Deploys all v0.8.5 libraries and facets. Supports resume -- if `deployed-facets.json` already exists, previously deployed contracts are skipped.

```bash
npx hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
```

Output: `scripts/upgrade/output/deployed-facets.json`

## Step 2: Apply Upgrade

### EOA path

Reads `deployed-facets.json`, diffs selectors against the live diamond, and executes a single `diamondCut` transaction from the connected signer (via Hardhat keystore).

```bash
npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum

# Override diamond address
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum

# Custom facets file
FACETS_FILE=./path/to/deployed-facets.json npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum
```

Output:
- `scripts/upgrade/output/upgrade-details.json` -- selector changes (add/replace/remove)

The script applies all facet cuts in a **single transaction** (no chunking needed for EOA).

### Safe path

Generates Safe Transaction Builder JSON for the full upgrade (roles, pause, params, migration role, AccountLayer/InstantLayer wiring) plus separate diamondCut calldata.

**Prerequisites:** Deploy AccountLayer Diamond and InstantLayer separately before running this script, then set `accountLayerDiamondAddress` and `instantLayerAddress` in `upgrade.json`. If these addresses are provided, wiring transactions (role grants, hook registration, whitelisting) are included in the Safe batch.

```bash
npx hardhat run scripts/upgrade/generateSafeUpgradeTxs.ts --network arbitrum
```

Output:
- `scripts/upgrade/output/safe-batch.json` -- Safe Transaction Builder JSON (non-diamondCut txs, includes AL/IL wiring if addresses set)
- `scripts/upgrade/output/diamondcut-calldata.json` -- raw diamondCut calldata chunks
- `scripts/upgrade/output/upgrade-details.json` -- selector changes + breakdown

Execute in Safe UI:
1. Execute the diamondCut calldata from `diamondcut-calldata.json` (via timelock or direct)
2. Import `safe-batch.json` into the Safe Transaction Builder to execute role grants, pause, params, and AL/IL wiring

## Step 3: Prepare Migration Input

Wait for the subgraph to sync past the upgrade block, then fetch and validate migration data.

```bash
DIAMOND_ADDRESS=0x... \
  npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network arbitrum
```

What it does:
- Fetches all open quotes from the subgraph
- Fetches all PartyB-per-PartyA balance entries from the subgraph
- Validates a random sample against on-chain state (boundary check + spot-checks)
- Computes expected aggregated positions for post-migration verification
- Writes validated JSON input file

Output: `scripts/upgrade/output/migration-input.json`

## Step 4: Run Migration

Execute migration using the validated input file. The executor must have `MIGRATION_ROLE`.

```bash
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network arbitrum
```

What it does:
- **Phase 1: Quote migration** -- calls `migrateQuotes()` in chunks (populates aggregated positions, connections, funding baselines)
- **Phase 2: PartyB balance migration** -- calls `migrateCrossLockedValues()` in chunks per PartyB (aggregates per-PartyA balances into cross bucket)
- **Verification** -- checks every quote is migrated, master balances match, aggregated positions correct

Output: `scripts/upgrade/output/migration-report.json`

### Resume after failure

If the script fails (RPC error, gas issue), re-run the same command. It reads `migration-progress.json` and resumes from the last successful operation.

### Dry run

```bash
DRY_RUN=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network arbitrum
```

## Step 5: Post-Migration

After `migration-report.json` shows `"status": "success"`, generate and execute post-migration transactions.

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/generatePostMigrationTxs.ts --network arbitrum

# With Safe batch output
DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/upgrade/generatePostMigrationTxs.ts --network arbitrum
```

PartyB addresses are read from `postMigration.json` config (`partyBs` array).

The generated transactions, in order:

| # | Transaction | Purpose |
|---|------------|---------|
| 1 | `unpauseGlobal()` | Resume system operations |
| 2 | `setCrossPartyBModeActivated(true)` | Enable cross-PartyB feature flag |
| 3+ | `setCrossPartyB(partyB, true)` | Enable cross mode per PartyB |

Output:
- `scripts/upgrade/output/post-migration-transactions.json` -- raw calldata (always)
- `scripts/upgrade/output/post-migration-safe-batch.json` -- Safe batch (if SAFE_ADDRESS set)

## Production Verification

After the diamondCut:
- Review `upgrade-details.json` for the full selector diff (added, replaced, removed selectors with function signatures)
- Call `DiamondLoupeFacet.facets()` on-chain to confirm all v0.8.5 facet addresses are registered
- Call a v0.8.5-only function (e.g. `setCrossPartyBModeActivated`) to confirm it responds

After migration:
```bash
jq '{status, error}' scripts/upgrade/output/migration-report.json
```

The migration report includes:
- `quoteChecks` -- number of quotes verified as migrated
- `partyBChecks` -- number of PartyBs with verified master balances
- `aggregateChecks` -- number of aggregated position entries verified

## Configuration

### Upgrade config (`upgrade.json`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `diamondAddress` | string | -- | Diamond proxy address on the target network |
| `adminAddress` | string | `""` | Address that receives role grants (for Safe path) |
| `safeAddress` | string | `""` | Gnosis Safe address (Safe path only) |
| `migrationRunner` | string | `""` | Address granted MIGRATION_ROLE (defaults to adminAddress) |
| `diamondCutChunkSize` | number | `1000` | Max facet cuts per diamondCut transaction |
| `execute` | boolean | `false` | Execute transactions on-chain after generating (for fork testing) |
| `symmioFeeReceiver` | string | `""` | Fee receiver for AccountLayer Init (defaults to admin) |
| `setupInstantLayerTemplates` | boolean | `true` | Setup OpenPosition/ClosePosition templates on InstantLayer |
| `accountLayerDiamondAddress` | string | `""` | Pre-deployed AccountLayer address (Safe path -- wiring only) |
| `instantLayerAddress` | string | `""` | Pre-deployed InstantLayer address (Safe path -- wiring only) |
| `newV085Parameters` | object | -- | New v0.8.5 parameters to initialize (see below) |

### Env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `FACETS_FILE` | Path to `deployed-facets.json` |
| `UPGRADE_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/upgrade.json`) |

### Config files by script

| Config file | Script | Key fields |
|-------------|--------|------------|
| `upgrade.json` | `eoaUpgrade.ts`, `applyUpgrade.ts`, `generateSafeUpgradeTxs.ts` | `diamondAddress`, `adminAddress`, `newV085Parameters` |
| `prepareMigration.json` | `prepareMigrationInput.ts` | `diamondAddress`, `subgraphEndpoint` |
| `migrate.json` | `runMigration.ts` | `diamondAddress`, `migrationInputFile`, `chunkSize` |
| `postMigration.json` | `generatePostMigrationTxs.ts` | `diamondAddress`, `partyBs` |

## newV085Parameters

These are parameters that **only exist in v0.8.5** (not in v0.8.4 storage). After `diamondCut`, they default to 0 and must be initialized.

**Must-set (blocks migration if 0):**
- `maxPartyAConnectionLimit` -- migration calls `addConnection()` which checks this limit

**Should-set (needed for v0.8.5 features to work):**
- `signatureVerifierAddress` -- Muon signature verifier contract
- `liquidationInsuranceVault` + `maxLiquidationProfitPerPosition` -- insurance vault config
- `softLiquidationPenaltyCollector` -- soft liquidation penalty receiver
- `minAffiliateFee` -- minimum affiliate fee floor
- `unbindCooldown` -- binding cooldown
- `maxWithdrawParts` -- max parts per withdrawal request
- `minWithdrawCooldown` -- withdrawal cooldown

Existing v0.8.4 parameters (cooldowns, limits, fee shares, etc.) are preserved in storage and NOT overwritten.

## Troubleshooting

**"maxPartyAConnectionLimit" error during migration**
Set `maxPartyAConnectionLimit` in `newV085Parameters` config. Defaults to 0 after upgrade, which blocks migration.

**Subgraph not synced**
Wait for the subgraph to index past the upgrade block before running `prepareMigrationInput.ts`.

**Transaction failures during migration**
The script retries 3x with exponential backoff. Check RPC health, gas balance, and `MIGRATION_ROLE` grant.

**Stuck migration**
Delete `migration-progress.json` and re-run. Already-migrated items are skipped via on-chain checks.
