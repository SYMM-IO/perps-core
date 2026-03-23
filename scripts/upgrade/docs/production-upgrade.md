# Production Upgrade (v0.8.4 -> v0.8.5)

## Overview

The production upgrade flow depends on whether the diamond is owned by an EOA or a multisig (Gnosis Safe). In both paths, all contract deployments happen **before** the system is paused to minimize downtime.

## Safe Path (Production)

```
BEFORE PAUSE (no downtime)
══════════════════════════

 deployFacets.ts                deployPeripherals.ts
 (deploy libs + facets)         (deploy AL + IL + PartyB impl)
        │                              │
        ▼                              ▼
 deployed-facets.json          deployed-peripherals.json
        │                              │
        └──────────┬───────────────────┘
                   ▼
         generateSafeBatch.ts
         (reads both, no on-chain actions)
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
  safe-batch.json    diamondcut-calldata.json


PAUSE STARTS (execute via Safe UI)
══════════════════════════════════
  safe-batch.json contains:
    1. grantRole(PAUSER_ROLE)
    2. grantRole(UNPAUSER_ROLE)
    3. pauseGlobal()              <-- PAUSE
    4. grantRole(PROTOCOL_CONFIG / COOLDOWN_ADMIN / FEE_ADMIN)
    5. set v0.8.5 parameters
    6. grantRole(MIGRATION_ROLE)
    7. [wiring] AL/IL roles + hooks + whitelist
    8. [wiring] upgradeTo(PartyB impl)  <-- UUPS (*)
    9. [wiring] registerPartyBs on IL

  (*) Safe must have DEFAULT_ADMIN_ROLE on SymmioPartyB
      before executing. Grant via current PartyB admin.

  diamondcut-calldata.json:
    diamondCut (chunked, executed separately)


MIGRATION (system still paused)
═══════════════════════════════

 prepareMigrationInput.ts       (read-only: subgraph + on-chain)
        │
        ▼
 migration-input.json
        │
        ▼
 runMigration.ts                (migrateQuotes + migrateCrossLocked + verify)
        │
        ▼
 migration-report.json


UNPAUSE
═══════

 generatePostMigrationBatch.ts  (generates calldata, no on-chain)
        │
        ▼
  Execute via Safe UI:
    1. unpauseGlobal()            <-- UNPAUSE
    2. setCrossPartyBModeActivated(true)
    3. setCrossPartyB(partyB, true) x N
```

## EOA Path

**Single script:**

1. **Upgrade** (`eoaUpgrade.ts`) -- deploy facets, pause, diamondCut, set params, deploy AL + IL, wire, grant migration role
2. **Prepare migration input** (`prepareMigrationInput.ts`)
3. **Run migration** (`runMigration.ts`)
4. **Post-migration** (`generatePostMigrationBatch.ts`) -- unpause, enable cross-PartyB mode

**Step-by-step:**

1. **Deploy facets** (`deployFacets.ts`) -- before pause
2. **Apply upgrade** (`applyUpgrade.ts`) -- diamondCut only (pause manually first)
3. **Prepare migration input** (`prepareMigrationInput.ts`)
4. **Run migration** (`runMigration.ts`)
5. **Post-migration** (`generatePostMigrationBatch.ts`)

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
2. Run `eoaUpgrade.ts --network docker` against it
3. Run `verifyDiamond.ts` to confirm core diamond selectors
4. Run `verifyPeripherals.ts` to confirm AL/IL/PartyB wiring
5. Run `testTemplateExecution.ts` to verify InstantLayer template execution end-to-end

```bash
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network docker

# Verify core diamond selectors
npx hardhat run scripts/upgrade/verifyDiamond.ts --network docker

# Verify peripheral wiring (AL + IL + PartyB)
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network docker

# End-to-end template execution test
DIAMOND_ADDRESS=0x... ACCOUNT_LAYER_ADDRESS=0x... INSTANT_LAYER_ADDRESS=0x... \
  npx hardhat run scripts/upgrade/testTemplateExecution.ts --network docker
```

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

**Prerequisites:** Run `deployFacets.ts` and `deployPeripherals.ts` first. The script auto-loads `deployed-facets.json` and `deployed-peripherals.json` from the output directory -- no manual address copy needed. Set `symmioPartyBAddress` in `upgrade.json` to include PartyB UUPS upgrade + InstantLayer registration in the Safe batch. Config and env vars override auto-loaded values if set.

```bash
npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
```

Output:
- `scripts/upgrade/output/safe-batch.json` -- Safe Transaction Builder JSON (non-diamondCut txs, includes AL/IL wiring if addresses set)
- `scripts/upgrade/output/diamondcut-calldata.json` -- raw diamondCut calldata chunks
- `scripts/upgrade/output/upgrade-details.json` -- selector changes + breakdown

Execute in Safe UI:
1. Import `safe-batch.json` into the Safe Transaction Builder (includes pause, role grants, params, wiring)
2. Execute the diamondCut calldata from `diamondcut-calldata.json` (via timelock or direct)
3. The batch pauses the system first, then applies params and wiring after diamondCut

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
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/generatePostMigrationBatch.ts --network arbitrum

# With Safe batch output
DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/upgrade/generatePostMigrationBatch.ts --network arbitrum
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
| `symmioFeeReceiver` | string | `""` | Fee receiver for AccountLayer Init (defaults to admin) |
| `setupInstantLayerTemplates` | boolean | `true` | Setup OpenPosition/ClosePosition templates on InstantLayer |
| `symmioPartyBAddress` | string | `""` | Existing SymmioPartyB proxy address (for UUPS upgrade + InstantLayer registration) |
| `newV085Parameters` | object | -- | New v0.8.5 parameters to initialize (see below) |

`accountLayerDiamondAddress`, `instantLayerAddress`, and `symmioPartyBImplementation` are auto-loaded from `deployed-peripherals.json`. They can still be set in config or env vars as overrides.

### Env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `FACETS_FILE` | Path to `deployed-facets.json` |
| `PERIPHERALS_FILE` | Path to `deployed-peripherals.json` |
| `UPGRADE_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/upgrade.json`) |

### Config files by script

| Config file | Script | Key fields |
|-------------|--------|------------|
| `upgrade.json` | `eoaUpgrade.ts`, `applyUpgrade.ts`, `generateSafeBatch.ts` | `diamondAddress`, `adminAddress`, `newV085Parameters` |
| `prepareMigration.json` | `prepareMigrationInput.ts` | `diamondAddress`, `subgraphEndpoint` |
| `migrate.json` | `runMigration.ts` | `diamondAddress`, `migrationInputFile`, `chunkSize` |
| `postMigration.json` | `generatePostMigrationBatch.ts` | `diamondAddress`, `partyBs` |

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
