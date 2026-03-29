# Production Upgrade (v0.8.4 -> v0.8.5)

## Overview

The production upgrade flow depends on whether the diamond is owned by an EOA or a multisig (Gnosis Safe). In both paths, all contract deployments happen **before** the system is paused to minimize downtime.

## Safe Path (Production)

```
DEPLOY SIGNATURE VERIFIER (one-time, if upgrading from v0.8.4)
══════════════════════════════════════════════════════════════
  v0.8.4 had signature verification inline in the diamond.
  v0.8.5 uses an external MuonSignatureVerifier contract.

  npx hardhat deploy:signatureVerifier --admin <admin> --network <network>

  Then configure Muon TSS keys + gateway signers on the new contract.
  Put the deployed address in upgrade.json → newV085Parameters.signatureVerifierAddress


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

**Pre-requisite (if upgrading from v0.8.4):** Deploy `MuonSignatureVerifier` first (see [Deploy SignatureVerifier](#deploy-signatureverifier)).

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

- Deployment info for the target network (see [Address Mapping](#address-mapping) below)
- Subgraph endpoint synced to current chain state (for migration)
- `.env` with deployer private key (`TEAM_DEPLOYER`) and optional RPC override (`RPC_<NETWORK>`)
- Config files:
  ```bash
  cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade.json
  cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json
  cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate.json
  cp scripts/upgrade/config/samples/postMigration.sample.json scripts/upgrade/config/postMigration.json
  cp scripts/upgrade/config/samples/deployPeripherals.sample.json scripts/upgrade/config/deployPeripherals.json
  # edit each file -- see Configuration section below
  ```

## Address Mapping

Every Symmio deployment has a standard set of contracts and roles. The table below maps these to the config fields used by the upgrade scripts.

| Deployment name | Example | Config field | Where it goes |
|----------------|---------|-------------|---------------|
| **Symmio** (diamond proxy) | `0x2Ecc...38B5` | `diamondAddress` | `upgrade.json`, `prepareMigration.json`, `migrate.json`, `postMigration.json` |
| **Main MultiSig** (Gnosis Safe that owns the diamond) | `0x0C83...AFC4` | `safeAddress` | `upgrade.json`, `postMigration.json` |
| **Main MultiSig** (also receives role grants) | `0x0C83...AFC4` | `adminAddress` | `upgrade.json`, `deployPeripherals.json` |
| **Fees MultiSig** (receives protocol fees) | `0x273a...3f12` | `symmioFeeReceiver` | `upgrade.json`, `deployPeripherals.json` |
| **SignatureVerifier** (Muon signature verification contract) | `0x94eE...FC2` | `newV085Parameters.signatureVerifierAddress` | `upgrade.json` |
| **SymmioPartyB** (existing PartyB proxy, if deployed) | `0xd600...B574` | `symmioPartyBAddress` | `upgrade.json`, `deployPeripherals.json` |
| **TimeLock** (12H or 3D, if diamond owner is a timelock) | `0xA75F...c63` | -- | Not in config; execute diamondCut via timelock manually |
| **Migration runner** (address that will call migration functions) | any EOA or multisig | `migrationRunner` | `upgrade.json` (defaults to `adminAddress`) |
| **PartyB addresses** (all active PartyBs to enable cross mode) | `[0x...]` | `partyBs` | `postMigration.json` |
| **Subgraph endpoint** (Goldsky/TheGraph for this chain) | `https://api.goldsky.com/...` | `subgraphEndpoint` | `upgrade.json`, `prepareMigration.json` |

**Notes:**
- `adminAddress` and `safeAddress` are often the same address (the Main MultiSig). Use `adminAddress` for the address that should receive role grants; use `safeAddress` for the Safe Transaction Builder target.
- If the diamond is owned by a **TimeLock** that is itself owned by the Main MultiSig, set `safeAddress` to the Main MultiSig and `adminAddress` to the TimeLock (since the TimeLock is the actual diamond owner that executes role grants).
- `migrationRunner` defaults to `adminAddress` if not set. This is the address granted `MIGRATION_ROLE` to execute `migrateQuotes()` and `migrateCrossLockedValues()`.
- Contracts like Collateral, Pauser, Symbol Manager, RebalancerToMsig, CallProxy Liquidator, and Fees Manager are **not** part of the upgrade config -- they are unchanged by the v0.8.5 upgrade.

## Testing

Before running the upgrade in production, test the full flow on localhost:

1. Deploy v0.8.4 from the previous codebase to a local Hardhat node
2. Run `eoaUpgrade.ts --network docker` against it
3. Run verification scripts

```bash
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network docker
npx hardhat run scripts/upgrade/verifyDiamond.ts --network docker
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network docker
npx hardhat run scripts/upgrade/testTemplateExecution.ts --network docker
```

### Fork rehearsal

Test against real on-chain state before production:

```bash
# 1. Run upgrade on fork
npx hardhat run scripts/upgrade/forkUpgrade.ts --network fork-arbitrum

# 2. Verify (all auto-load from upgrade.json + output files)
npx hardhat run scripts/upgrade/verifyDiamond.ts --network fork-arbitrum
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network fork-arbitrum
FORK=true npx hardhat run scripts/upgrade/testTemplateExecution.ts --network fork-arbitrum

# 3. Run migration
npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network fork-arbitrum
npx hardhat run scripts/upgrade/runMigration.ts --network fork-arbitrum
```

### Verification scripts

| Script | What it checks |
|--------|---------------|
| `verifyDiamond.ts` | All v0.8.5 facet selectors registered on diamond |
| `verifyPeripherals.ts` | AccountLayer + InstantLayer roles, hooks, whitelist, templates |
| `testTemplateExecution.ts` | Full end-to-end: affiliate registration, sub-account, PartyB UUPS upgrade, EIP-712 delegation, sendQuote -> lockQuote -> openPosition via InstantLayer template |

`testTemplateExecution.ts` auto-loads `diamondAddress` and `symmioPartyBAddress` from `upgrade.json`, and `accountLayerDiamondAddress` + `instantLayerAddress` from the output files. No manual config needed.

**What is NOT covered by these scripts** (verified elsewhere):
- Migration correctness -- `forkUpgrade.ts` step 11 verifies pre/post upgrade snapshots; `runMigration.ts` verifies all migrated data
- v0.8.5 parameter values -- check on-chain after batch execution
- Cross-PartyB mode -- enabled post-migration via `generatePostMigrationBatch.ts`

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

## Deploy SignatureVerifier

**Required when upgrading from v0.8.4.** In v0.8.4, Muon signature verification was inline in the diamond via `LibMuon`. In v0.8.5, it is refactored into an external `MuonSignatureVerifier` contract (`contracts/helpers/verification/SymmioSignatureVerifier.sol`) that must be deployed separately.

```bash
# --admin: address that can manage TSS keys and gateway signers on the verifier
# Typically the diamond owner (TimeLock or MultiSig)
npx hardhat deploy:signatureVerifier --admin <admin-address> --network <network>
```

After deployment:
1. Note the deployed address
2. Configure Muon TSS public keys and gateway signers on the new contract (via the admin)
3. Set the address in `upgrade.json` -> `newV085Parameters.signatureVerifierAddress`

If upgrading a chain that already runs v0.8.5 (or where the verifier was deployed previously), skip this step and use the existing verifier address.

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

After the diamondCut + wiring batch:

```bash
# Verify all v0.8.5 facet selectors are registered
npx hardhat run scripts/upgrade/verifyDiamond.ts --network arbitrum

# Verify AccountLayer + InstantLayer wiring (roles, hooks, templates)
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network arbitrum
```

Also review `upgrade-details.json` for the full selector diff (added, replaced, removed).

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

| Field | Type | Default | What to put here |
|-------|------|---------|-----------------|
| `diamondAddress` | string | -- | **Symmio** diamond proxy address (the main protocol contract) |
| `adminAddress` | string | `""` | **Main MultiSig** (or TimeLock) -- the address that owns the diamond and will receive role grants |
| `safeAddress` | string | `""` | **Main MultiSig** -- the Gnosis Safe used in Safe Transaction Builder (Safe path only) |
| `migrationRunner` | string | `""` | Address that will run `migrateQuotes` / `migrateCrossLockedValues` (defaults to `adminAddress` if empty) |
| `diamondCutChunkSize` | number | `1000` | Max facet selector changes per `diamondCut` transaction (increase only if hitting gas limits) |
| `subgraphEndpoint` | string | `""` | Goldsky / TheGraph subgraph URL for this chain (used by `prepareMigrationInput.ts`) |
| `spotCheckCount` | number | `20` | Number of random quotes/balances to verify against on-chain state during migration prep |
| `symmioFeeReceiver` | string | `""` | **Fees MultiSig** -- receives protocol fees in AccountLayer (defaults to `adminAddress` if empty) |
| `setupInstantLayerTemplates` | boolean | `true` | Whether to register OpenPosition + ClosePosition templates on InstantLayer |
| `symmioPartyBAddress` | string | `""` | Existing **SymmioPartyB** proxy address -- needed for UUPS upgrade + InstantLayer PartyB registration |
| `newV085Parameters` | object | -- | New v0.8.5 parameters (see [newV085Parameters](#newv085parameters) below) |

`accountLayerDiamondAddress`, `instantLayerAddress`, and `symmioPartyBImplementation` are auto-loaded from `deployed-peripherals.json`. They can still be set in config or env vars as overrides.

### Deploy peripherals config (`deployPeripherals.json`)

Note: `adminAddress` here is **different** from `upgrade.json`. In `upgrade.json` it's the diamond owner (e.g. TimeLock). Here it's the admin for the **newly deployed** AccountLayer + InstantLayer contracts -- typically the **Main MultiSig** directly.

| Field | Type | What to put here |
|-------|------|-----------------|
| `diamondAddress` | string | **Symmio** diamond proxy address |
| `adminAddress` | string | **Main MultiSig** -- will be set as owner/admin for the new AccountLayer + InstantLayer contracts |
| `symmioFeeReceiver` | string | **Fees MultiSig** -- fee receiver for AccountLayer initialization |
| `symmioPartyBAddress` | string | Existing **SymmioPartyB** proxy address (for UUPS upgrade to new implementation). Leave empty if no PartyB proxy exists. |

### Prepare migration config (`prepareMigration.json`)

| Field | Type | What to put here |
|-------|------|-----------------|
| `diamondAddress` | string | **Symmio** diamond proxy address |
| `subgraphEndpoint` | string | Goldsky / TheGraph subgraph URL for this chain |
| `spotCheckCount` | number | Number of random entries to verify against on-chain (default 20) |

### Migration config (`migrate.json`)

| Field | Type | What to put here |
|-------|------|-----------------|
| `diamondAddress` | string | **Symmio** diamond proxy address |
| `migrationInputFile` | string | Path to `migration-input.json` (output of previous step) |
| `chunkSize` | number | Quotes per `migrateQuotes` transaction (default 50) |
| `dryRun` | boolean | `true` to simulate without sending transactions |
| `fork` | boolean | `true` if running on a fork network |

### Post-migration config (`postMigration.json`)

| Field | Type | What to put here |
|-------|------|-----------------|
| `diamondAddress` | string | **Symmio** diamond proxy address |
| `safeAddress` | string | **Main MultiSig** -- for Safe batch output (leave empty for EOA path) |
| `partyBs` | string[] | List of all active **PartyB** addresses to enable cross mode for |

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

These parameters **only exist in v0.8.5** (not in v0.8.4 storage). After `diamondCut`, they default to 0 and must be initialized.

| Parameter | Type | What to put here |
|-----------|------|-----------------|
| `maxPartyAConnectionLimit` | number | **REQUIRED** -- max PartyBs a PartyA can connect to. Migration fails if 0. Typical value: `5` |
| `signatureVerifierAddress` | address | **SignatureVerifier** contract address -- the Muon oracle signature verification contract from your deployment |
| `liquidationInsuranceVault` | address | Address that receives liquidation insurance -- typically the **Fees MultiSig** |
| `maxLiquidationProfitPerPosition` | string (wei) | Max profit kept from liquidation per position. Example: `"1000000000000000000"` = 1 token |
| `softLiquidationPenaltyCollector` | address | Address that receives soft liquidation penalties -- typically the **Fees MultiSig** |
| `minAffiliateFee` | string (wei) | Minimum affiliate fee floor. Example: `"100000000000000000"` = 0.1 token |
| `unbindCooldown` | number (seconds) | Cooldown before a PartyA can unbind from a PartyB. Example: `86400` = 1 day |
| `maxWithdrawParts` | number | Max parts a withdrawal can be split into. Example: `5` |
| `minWithdrawCooldown` | number (seconds) | Min time between withdrawal parts. Example: `43200` = 12 hours |

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
