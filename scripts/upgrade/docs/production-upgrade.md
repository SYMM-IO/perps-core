# Production Upgrade (v0.8.4 -> v0.8.5)

## Overview

The production upgrade flow depends on whether the diamond is owned by an EOA or a multisig (Gnosis Safe). In both paths, all contract deployments happen **before** the system is paused to minimize downtime.

## Safe Path (Production)

There are two variants depending on whether the diamond is owned directly by the Safe or by a TimeLock contract (which is itself owned by the Safe). The timelock variant schedules the diamondCut **before** pausing, so the timelock delay passes while the system is still live -- minimizing downtime.

### Safe Path: Direct (Safe owns diamond)

```
READ MUON CONFIG (one-time, if upgrading from v0.8.4)
═════════════════════════════════════════════════════
  Reads TSS public key + gateway signer from the v0.8.4 diamond.
  Paste output into upgrade.json → newV085Parameters.

  readMuonConfig.ts → muon-config.json + console snippet

DEPLOY SIGNATURE VERIFIER (one-time, if upgrading from v0.8.4)
══════════════════════════════════════════════════════════════
  v0.8.4 had signature verification inline in the diamond.
  v0.8.5 uses an external MuonSignatureVerifier contract.

  npx hardhat deploy:signatureVerifier --admin <admin> --network <network>

  Put the deployed address in upgrade.json → newV085Parameters.signatureVerifierAddress
  TSS keys + gateway signers are seeded automatically from muonPublicKeys/muonGatewaySigners in config.


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


VERIFY DEPLOYED CONTRACTS (block explorer)
═══════════════════════════════════════════
  npx hardhat run scripts/upgrade/verifyContracts.ts --network <network>

  Verifies all libraries, facets, and peripherals (AL, IL, PartyB impl)
  on the block explorer. Run after deployFacets + deployPeripherals.

VERIFY DEPLOYED BYTECODE (local vs on-chain)
═════════════════════════════════════════════
  RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyDeploy.ts
  RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripheralsDeploy.ts

  Compares on-chain bytecode against locally compiled artifacts.
  Handles library linking (core facets) and immutable variables (peripherals).
  Reads addresses from output/deployed-facets.json and deployed-peripherals.json.


PAUSE (execute via Safe UI)
══════════════════════════
  pause-safe-batch.json:
    1. grantRole(PAUSER_ROLE)
    2. grantRole(UNPAUSER_ROLE)
    3. pauseGlobal()              <-- PAUSE

DIAMONDCUT (execute via Safe UI)
════════════════════════════════
  diamondcut-calldata.json:
    diamondCut (executed as separate Safe tx)

POST-DIAMONDCUT (execute via Safe UI)
═════════════════════════════════════
  safe-batch.json contains:
    1. grantRole(PROTOCOL_CONFIG / COOLDOWN_ADMIN / FEE_ADMIN)
    2. set v0.8.5 parameters
    3. grantRole(MIGRATION_ROLE)
    4. [wiring] AL/IL roles + hooks + whitelist
    5. [wiring] registerPartyBs on IL (from config/partyBListForWhitelistSymbolType.json)


PREPARE MIGRATION INPUT (after pause — version-agnostic, can run before or after diamondCut)
════════════════════════════════════════════════════════════════════════════════════════════
  prepareMigrationInput.ts       (subgraph + boundary check — version-agnostic)
  validateMigrationInput.ts      (optional — random spot-check)
  validateMigrationEdgeCases.ts  (optional — boundary, fork drift, gap scan)


RUN MIGRATION (after diamondCut — requires v0.8.5)
═══════════════════════════════════════════════════

 runMigration.ts                (migrateQuotes + migrateCrossLocked + verify)
        │
        ▼
 migration-report.json

 setSymbolTypes.ts              (backfill symbolType for all symbols)
 whitelistSymbolTypes.ts        (whitelist symbol type per PartyB)


UNPAUSE
═══════

 generatePostMigrationBatch.ts  (generates calldata, no on-chain)
        │
        ▼
  Execute via Safe UI:
    1. unpauseGlobal()            <-- UNPAUSE
    2. setCrossPartyBModeActivated(true)
    3. setCrossPartyB(partyB, true) x N


POST-UPGRADE PATCHES (if needed after unpause)
═══════════════════════════════════════════════
  generateSymbolTypeRoleBatch.ts   (grant/revoke SYMBOL_MANAGER_ROLE via Safe)
  generateTemplateBatch.ts         (add InstantLayer templates via Safe)
  whitelistSymbolTypes.ts          (whitelist symbol type per PartyB)
```

### Safe Path: TimeLock (TimeLock owns diamond, Safe owns TimeLock)

When the diamond is behind a timelock, the diamondCut must be scheduled first and
executed after the delay. The key optimization: schedule the diamondCut **while the
system is still live**, wait for the delay to pass (no downtime), then pause + execute
the cut + migrate + unpause in a single maintenance window.

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
                              │
                              ▼
                    generateTimelockBatch.ts
                    (wraps diamondCut for timelock)
                              │
                    ┌─────────┴──────────────┐
                    ▼                        ▼
  timelock-schedule-safe-batch.json   timelock-execute-safe-batch.json


VERIFY DEPLOYED CONTRACTS (block explorer)
═══════════════════════════════════════════
  npx hardhat run scripts/upgrade/verifyContracts.ts --network <network>

VERIFY DEPLOYED BYTECODE (local vs on-chain)
═════════════════════════════════════════════
  node scripts/upgrade/verifyDeploy.mjs [RPC_URL] [FACETS_FILE]
  node scripts/upgrade/verifyPeripheralsDeploy.mjs [RPC_URL] [PERIPHERALS_FILE]


SCHEDULE DIAMONDCUT (T=0, system still live)
════════════════════════════════════════════
  Import timelock-schedule-safe-batch.json into Safe TX Builder
  Execute from Safe → calls timelock.schedule()
  Timer starts (e.g. 12 hours)


  ... timelock delay passes, system is still running normally ...


PAUSE (T=delay, downtime starts)
════════════════════════════════
  Import pause-safe-batch.json into Safe TX Builder
  Execute from Safe:
    1. grantRole(PAUSER_ROLE)
    2. grantRole(UNPAUSER_ROLE)
    3. pauseGlobal()              <-- PAUSE


EXECUTE DIAMONDCUT (T=delay, after pause)
═════════════════════════════════════════
  Import timelock-execute-safe-batch.json into Safe TX Builder
  Execute from Safe → calls timelock.execute()
  Diamond is now upgraded to v0.8.5


POST-DIAMONDCUT (T=delay, after diamondCut)
═══════════════════════════════════════════
  Import safe-batch.json into Safe TX Builder
  Execute from Safe:
    1. grantRole(PROTOCOL_CONFIG / COOLDOWN_ADMIN / FEE_ADMIN)
    2. set v0.8.5 parameters
    3. grantRole(MIGRATION_ROLE)
    4. [wiring] AL/IL roles + hooks + whitelist
    5. [wiring] registerPartyBs on IL (from config/partyBListForWhitelistSymbolType.json)


VERIFY
══════
  verifyDiamond.ts
  verifyPeripherals.ts


PREPARE MIGRATION INPUT (after pause — version-agnostic, can run before or after diamondCut)
════════════════════════════════════════════════════════════════════════════════════════════
  prepareMigrationInput.ts       (subgraph + boundary check — version-agnostic)
        │
        ▼
  migration-input.json

  validateMigrationInput.ts      (optional — random spot-check)
  validateMigrationEdgeCases.ts  (optional — boundary, fork drift, gap scan)


RUN MIGRATION (after diamondCut — requires v0.8.5)
═══════════════════════════════════════════════════

 runMigration.ts                (migrateQuotes + migrateCrossLocked + verify)
        │
        ▼
 migration-report.json

 setSymbolTypes.ts              (backfill symbolType for all symbols)
 whitelistSymbolTypes.ts        (whitelist symbol type per PartyB)


UNPAUSE
═══════

 generatePostMigrationBatch.ts  (generates calldata, no on-chain)
        │
        ▼
  Execute via Safe UI:
    1. unpauseGlobal()            <-- UNPAUSE
    2. setCrossPartyBModeActivated(true)
    3. setCrossPartyB(partyB, true) x N


POST-UPGRADE PATCHES (if needed after unpause)
═══════════════════════════════════════════════
  generateSymbolTypeRoleBatch.ts   (grant/revoke SYMBOL_MANAGER_ROLE via Safe)
  generateTemplateBatch.ts         (add InstantLayer templates via Safe)
  whitelistSymbolTypes.ts          (whitelist symbol type per PartyB)


TIMELINE
════════

  T=0          Schedule diamondCut on timelock
               (system still running normally)

  T=delay      Execute pause-safe-batch.json (pause)
               Execute timelock diamondCut
               Execute safe-batch.json (roles + params + wiring)
               Verify upgrade
               Prepare migration input
               Run migration
               Execute post-migration batch (unpause)

  Minimum downtime = time between pause and unpause.
  The timelock delay passes with zero downtime.
  Migration input is prepared before the diamondCut to save time.
```

## EOA Path

**Pre-requisites (if upgrading from v0.8.4):** Run `readMuonConfig.ts` to capture TSS key + gateway, then deploy `MuonSignatureVerifier` (see [Read Muon Config](#read-muon-config-from-v084-diamond) and [Deploy SignatureVerifier](#deploy-signatureverifier)). The EOA path seeds the verifier automatically from `muonPublicKeys`/`muonGatewaySigners` in config.

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
- Hardhat keystore with two private keys and optional RPC override (`RPC_<NETWORK>`):
  ```bash
  npx hardhat keystore set TEAM_DEPLOYER          # protocolAdmin / diamond owner key
  npx hardhat keystore set TEAM_MIGRATOR            # migrationRunner key (MIGRATION_ROLE)
  ```
  Scripts auto-select the correct signer by matching the address from `upgrade.json` (`protocolAdmin` / `migrationRunner`) against available signers. No env var switching needed.
- Config files:
  ```bash
  cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade.json
  cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json
  cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate.json
  cp scripts/upgrade/config/samples/postMigration.sample.json scripts/upgrade/config/postMigration.json
  cp scripts/upgrade/config/samples/partyBListForWhitelistSymbolType.sample.json scripts/upgrade/config/partyBListForWhitelistSymbolType.json
  cp scripts/upgrade/config/samples/instantLayerTemplates.sample.json scripts/upgrade/config/instantLayerTemplates.json
  cp scripts/upgrade/config/samples/deployPeripherals.sample.json scripts/upgrade/config/deployPeripherals.json
  # edit upgrade.json with all shared fields (diamondAddress, subgraphEndpoint, safeAddress, etc.)
  # other config files only need script-specific fields -- they fall back to upgrade.json for shared values
  ```

## Address Mapping

Every Symmio deployment has a standard set of contracts and roles. The table below maps these to the config fields used by the upgrade scripts.

| Deployment name | Example | Config field | Where it goes |
|----------------|---------|-------------|---------------|
| **Symmio** (diamond proxy) | `0x2Ecc...38B5` | `diamondAddress` | `upgrade.json` (other scripts fall back to this) |
| **Main MultiSig** (Gnosis Safe that owns the diamond) | `0x0C83...AFC4` | `safeAddress` | `upgrade.json` (other scripts fall back to this) |
| **Main MultiSig** (also receives role grants) | `0x0C83...AFC4` | `adminAddress` | `upgrade.json`, `deployPeripherals.json` |
| **Fees MultiSig** (receives protocol fees) | `0x273a...3f12` | `symmioFeeReceiver` | `upgrade.json` (other scripts fall back to this) |
| **SignatureVerifier** (Muon signature verification contract) | `0x94eE...FC2` | `newV085Parameters.signatureVerifierAddress` | `upgrade.json` |
| **PartyB list** (for IL registration + symbol whitelisting) | -- | `partyBs` + `registerOnInstantLayer` | `config/partyBListForWhitelistSymbolType.json` |
| **TimeLock** (12H or 3D, if diamond owner is a timelock) | `0xA75F...c63` | `timelockAddress` | `upgrade.json` (used by `generateTimelockBatch.ts` to wrap diamondCut) |
| **Migration runner** (address that will call migration functions) | any EOA or multisig | `migrationRunner` | `upgrade.json` (defaults to `adminAddress`) |
| **PartyB addresses** (all active PartyBs to enable cross mode) | `[0x...]` | `partyBs` | `postMigration.json` |
| **Subgraph endpoint** (Goldsky/TheGraph for this chain) | `https://api.goldsky.com/...` | `subgraphEndpoint` | `upgrade.json` (other scripts fall back to this) |

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
| `verifyContracts.ts` | Block explorer verification of all deployed contracts (libraries, facets, peripherals). Reads from deploy output files and handles library linking automatically. |
| `verifyDeploy.ts` | Bytecode verification of deployed core facets (reads addresses from `output/deployed-facets.json`) against local compiled artifacts (library linking aware) |
| `verifyPeripheralsDeploy.ts` | Bytecode verification of deployed peripherals (AccountLayer, InstantLayer, SymmioPartyB impl, MuonSignatureVerifier) against local compiled artifacts. Handles library linking and immutable variable masking. |
| `verifyDiamond.ts` | All v0.8.5 facet selectors registered on diamond |
| `verifyPeripherals.ts` | AccountLayer + InstantLayer roles, hooks, whitelist, templates |
| `testTemplateExecution.ts` | Full end-to-end: affiliate registration, sub-account, PartyB UUPS upgrade, EIP-712 delegation, sendQuote -> lockQuote -> openPosition via InstantLayer template |

`testTemplateExecution.ts` auto-loads `diamondAddress` from `upgrade.json`, and `accountLayerDiamondAddress` + `instantLayerAddress` from the output files. No manual config needed.

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

## Read Muon Config from v0.8.4 Diamond

**Run before anything else** to capture the TSS public key and gateway signer from the live v0.8.4 diamond:

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/readMuonConfig.ts --network <network>
```

Reads `getMuonIds()` (public key, gateway, appId) and `getMuonConfig()` (validity times). The `muonAppId`, `upnlValidTime`, and `priceValidTime` persist in diamond storage across the upgrade -- they are output for reference only. The public key and gateway are what must be seeded onto the new external verifier.

Add the output to `upgrade.json` -> `newV085Parameters`:

```json
"muonPublicKeys": [{ "x": "123...", "parity": 1 }],
"muonGatewaySigners": ["0x..."]
```

Output: `scripts/upgrade/output/muon-config.json`

## Deploy SignatureVerifier

**Required when upgrading from v0.8.4.** In v0.8.4, Muon signature verification was inline in the diamond via `LibMuon`. In v0.8.5, it is refactored into an external `MuonSignatureVerifier` contract (`contracts/helpers/verification/SymmioSignatureVerifier.sol`) that must be deployed separately.

```bash
# --admin: address that can manage TSS keys and gateway signers on the verifier
# Typically the diamond owner (TimeLock or MultiSig)
npx hardhat deploy:signatureVerifier --admin <admin-address> --network <network>
```

After deployment:
1. Note the deployed address
2. Set the address in `upgrade.json` -> `newV085Parameters.signatureVerifierAddress`
3. TSS public keys and gateway signers are seeded automatically by the upgrade scripts (from `muonPublicKeys` and `muonGatewaySigners` in config). The Safe must have `SETTER_ROLE` on the verifier.

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

**Prerequisites:** Run `deployFacets.ts` and `deployPeripherals.ts` first. The script auto-loads `deployed-facets.json` and `deployed-peripherals.json` from the output directory -- no manual address copy needed. InstantLayer PartyB registration reads from `config/partyBListForWhitelistSymbolType.json` (when `registerOnInstantLayer` is true). Config and env vars override auto-loaded values if set.

```bash
npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
```

Output:
- `scripts/upgrade/output/pause-safe-batch.json` -- Safe batch for pause (grantRole PAUSER/UNPAUSER + pauseGlobal)
- `scripts/upgrade/output/safe-batch.json` -- Safe batch for post-diamondCut (roles, params, wiring)
- `scripts/upgrade/output/diamondcut-calldata.json` -- raw diamondCut calldata chunks
- `scripts/upgrade/output/upgrade-details.json` -- selector changes + breakdown

**Direct (Safe owns diamond):**
1. Import `pause-safe-batch.json` → execute (pause system)
2. Execute the diamondCut calldata from `diamondcut-calldata.json` as a separate Safe tx
3. Import `safe-batch.json` → execute (roles + params + wiring)

**TimeLock (TimeLock owns diamond):**
1. Run `generateTimelockBatch.ts` first (see [Step 2b](#step-2b-wrap-diamondcut-for-timelock))
2. Import `timelock-schedule-safe-batch.json` → execute (schedules diamondCut, timer starts)
3. Wait for timelock delay (system still live)
4. Import `pause-safe-batch.json` → execute (pause)
5. Import `timelock-execute-safe-batch.json` → execute (applies diamondCut)
6. Import `safe-batch.json` → execute (roles + params + wiring)

## Step 2b: Wrap DiamondCut for TimeLock

**Only needed when the diamond is owned by a TimeLock contract.** Reads `diamondcut-calldata.json` (output of `generateSafeBatch.ts`), fetches `minDelay` from the timelock, and wraps the diamondCut as timelock `schedule()` + `execute()` calls.

Requires `timelockAddress` in `upgrade.json` (or `TIMELOCK_ADDRESS` env var).

```bash
npx hardhat run scripts/upgrade/generateTimelockBatch.ts --network arbitrum
```

Output:
- `scripts/upgrade/output/timelock-schedule-safe-batch.json` -- Safe batch to schedule the diamondCut (execute immediately at T=0)
- `scripts/upgrade/output/timelock-execute-safe-batch.json` -- Safe batch to execute after timelock delay

Uses a deterministic salt derived from chain ID + diamond address + version string.

## Step 3: Prepare Migration Input

Fetches subgraph data and builds the migration input file. **Can run before or after the diamondCut** — uses only version-agnostic on-chain calls (`getNextQuoteId`, which returns the last assigned ID). Run it early (e.g. right after pausing) to minimize downtime.

```bash
npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network arbitrum
```

What it does:
- Fetches all open quotes from the subgraph
- Fetches all PartyB-per-PartyA balance entries from the subgraph
- Validates boundary against on-chain `getNextQuoteId()` (returns last assigned ID, not next available)
- Computes expected aggregated positions for post-migration verification
- Writes JSON input file

Output: `scripts/upgrade/output/migration-input.json`

## Step 3b: Validate Migration Input (optional)

Two complementary scripts validate the input. Both use raw `eth_call` and work on v0.8.4 and v0.8.5.

**`validateMigrationInput.ts`** -- random spot-checks quotes and balances for broad coverage:

```bash
npx hardhat run scripts/upgrade/validateMigrationInput.ts --network arbitrum
```

**`validateMigrationEdgeCases.ts`** -- deterministic checks for corner cases (boundary quote at `lastId`, fork drift, gap scan, partyB completeness). Especially important on fork tests:

```bash
npx hardhat run scripts/upgrade/validateMigrationEdgeCases.ts --network arbitrum
```

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

### Block explorer verification

After deploying facets and peripherals (before or after the diamondCut):

```bash
npx hardhat run scripts/upgrade/verifyContracts.ts --network <network>
```

Verifies all libraries, core facets, AccountLayer contracts (DiamondCutFacet, Diamond, Init, libraries, facets), InstantLayer, and SymmioPartyB implementation. Library dependencies and contract path disambiguation are handled automatically. Addresses are read dynamically from `scripts/upgrade/output/deployed-facets.json` and `deployed-peripherals.json`, constructor args from `config/upgrade.json`. Resume with `SKIP=N` if a contract fails.

### Bytecode verification (local vs on-chain)

Compares the on-chain deployed bytecode against locally compiled Hardhat artifacts. This is independent of block explorer verification and works for any RPC-accessible network.

```bash
# Core facets: reads deployed-facets.json
RPC_URL=https://rpc.mantle.xyz npx ts-node scripts/upgrade/verifyDeploy.ts

# Peripherals: reads deployed-peripherals.json
RPC_URL=https://rpc.mantle.xyz npx ts-node scripts/upgrade/verifyPeripheralsDeploy.ts
```

Both read addresses from `scripts/upgrade/output/` files (`deployed-facets.json` and `deployed-peripherals.json` respectively). `verifyPeripheralsDeploy.ts` also picks up the `MuonSignatureVerifier` address from `upgrade.json` (`newV085Parameters.signatureVerifierAddress`).

Override env vars:

```bash
FACETS_FILE=./output/deployed-facets-arb.json RPC_URL=https://arb1.arbitrum.io/rpc npx ts-node scripts/upgrade/verifyDeploy.ts
PERIPHERALS_FILE=./output/deployed-peripherals-arb.json RPC_URL=https://arb1.arbitrum.io/rpc npx ts-node scripts/upgrade/verifyPeripheralsDeploy.ts
```

**When to run:** after `deployFacets.ts` / `deployPeripherals.ts` and before applying the diamondCut, to confirm the standalone pre-deployed bytecodes match the local compiled source.

**What they handle:**
- **Library linking** -- facets that use external libraries (e.g. `LibQuoteFunding`, `LibSettlement`) have placeholder slots in compiled bytecode. The scripts extract actual library addresses from on-chain bytecode and substitute them before comparing.
- **Immutable variables** -- contracts like `InstantLayer` and `SymmioPartyB` embed constructor-set values (EIP-712 domain, symmio address, etc.) in deployed bytecode. The scripts mask these regions using `immutableReferences` from the artifact before comparing, and report the on-chain values.

**Prerequisites:** Run `npx hardhat compile` first. Artifacts must be present in `artifacts/contracts/`.

### On-chain verification

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
| `timelockAddress` | string | `""` | **TimeLock** contract address -- set if diamond is owned by a timelock (used by `generateTimelockBatch.ts`) |
| `diamondCutChunkSize` | number | `1000` | Max facet selector changes per `diamondCut` transaction (increase only if hitting gas limits) |
| `subgraphEndpoint` | string | `""` | Goldsky / TheGraph subgraph URL for this chain (used by `prepareMigrationInput.ts`) |
| `spotCheckCount` | number | `20` | Number of random quotes/balances to verify against on-chain state during migration prep |
| `symmioFeeReceiver` | string | `""` | **Fees MultiSig** -- receives protocol fees in AccountLayer (defaults to `adminAddress` if empty) |
| `setupInstantLayerTemplates` | boolean | `true` | Whether to register OpenPosition + ClosePosition templates on InstantLayer |
| `newV085Parameters` | object | -- | New v0.8.5 parameters (see [newV085Parameters](#newv085parameters) below) |

`accountLayerDiamondAddress`, `instantLayerAddress`, and `symmioPartyBImplementation` are auto-loaded from `deployed-peripherals.json`. They can still be set in config or env vars as overrides.

**Shared field fallback:** All per-script config files fall back to `upgrade.json` for shared fields (`diamondAddress`, `subgraphEndpoint`, `safeAddress`, `symmioFeeReceiver`, `spotCheckCount`). You only need to set these once in `upgrade.json` -- the other config files only need their script-specific fields. Per-script config values and env vars take precedence over `upgrade.json` when set.

### Deploy peripherals config (`deployPeripherals.json`)

Note: `adminAddress` here is **different** from `upgrade.json`. In `upgrade.json` it's the diamond owner (e.g. TimeLock). Here it's the admin for the **newly deployed** AccountLayer + InstantLayer contracts -- typically the **Main MultiSig** directly.

| Field | Type | What to put here |
|-------|------|-----------------|
| `adminAddress` | string | **Main MultiSig** -- will be set as owner/admin for the new AccountLayer + InstantLayer contracts |
| `symmioFeeReceiver` | string | **Fees MultiSig** -- fee receiver for AccountLayer initialization. Falls back to `upgrade.json`. |

### Prepare migration config (`prepareMigration.json`)

| Field | Type | What to put here |
|-------|------|-----------------|
| `spotCheckCount` | number | Number of random entries to verify against on-chain (default 20). Falls back to `upgrade.json`. |
| `outputDir` | string | Output directory (default `./scripts/upgrade/output`) |
| `outputFile` | string | Output file path (default `./scripts/upgrade/output/migration-input.json`) |

### Migration config (`migrate.json`)

| Field | Type | What to put here |
|-------|------|-----------------|
| `migrationInputFile` | string | Path to `migration-input.json` (output of previous step) |
| `chunkSize` | number | Quotes per `migrateQuotes` transaction (default 50) |
| `dryRun` | boolean | `true` to simulate without sending transactions |
| `fork` | boolean | `true` if running on a fork network |

### Post-migration config (`postMigration.json`)

| Field | Type | What to put here |
|-------|------|-----------------|
| `partyBs` | string[] | List of all active **PartyB** addresses to enable cross mode for |

### Env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `FACETS_FILE` | Path to `deployed-facets.json` |
| `PERIPHERALS_FILE` | Path to `deployed-peripherals.json` |
| `UPGRADE_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/upgrade.json`) |

### Config files by script

All scripts fall back to `upgrade.json` for `diamondAddress` and other shared fields. Per-script configs only need script-specific fields.

| Config file | Script | Script-specific fields | Shared fields (from `upgrade.json`) |
|-------------|--------|----------------------|-------------------------------------|
| `upgrade.json` | `eoaUpgrade.ts`, `applyUpgrade.ts`, `generateSafeBatch.ts`, `generateTimelockBatch.ts` | `adminAddress`, `timelockAddress`, `newV085Parameters`, `diamondCutChunkSize`, `migrationRunner` | -- (source of truth) |
| `deployPeripherals.json` | `deployPeripherals.ts` | `adminAddress` | `diamondAddress`, `symmioFeeReceiver` |
| `prepareMigration.json` | `prepareMigrationInput.ts` | `outputDir`, `outputFile` | `diamondAddress`, `subgraphEndpoint`, `spotCheckCount` |
| `migrate.json` | `runMigration.ts` | `migrationInputFile`, `chunkSize`, `dryRun`, `fork` | `diamondAddress` |
| `postMigration.json` | `generatePostMigrationBatch.ts` | `partyBs` | `diamondAddress`, `safeAddress` |
| `partyBListForWhitelistSymbolType.json` | `whitelistSymbolTypes.ts` | `partyBs` | `diamondAddress`, `newV085Parameters.symbolType` |
| `instantLayerTemplates.json` | `generateTemplateBatch.ts` | `templates` | `safeAddress`, `instantLayerAddress` |

## newV085Parameters

These parameters **only exist in v0.8.5** (not in v0.8.4 storage). After `diamondCut`, they default to 0 and must be initialized.

| Parameter | Type | What to put here |
|-----------|------|-----------------|
| `maxPartyAConnectionLimit` | number | **REQUIRED** -- max PartyBs a PartyA can connect to. Migration fails if 0. Typical value: `5` |
| `signatureVerifierAddress` | address | **SignatureVerifier** contract address -- the Muon oracle signature verification contract from your deployment |
| `muonPublicKeys` | array | TSS public keys to seed on the verifier. Each entry: `{ "x": "uint256", "parity": 0|1 }`. Read from the v0.8.4 diamond via `readMuonConfig.ts` |
| `muonGatewaySigners` | string[] | Gateway signer addresses to seed on the verifier. Read from the v0.8.4 diamond via `readMuonConfig.ts` |
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
