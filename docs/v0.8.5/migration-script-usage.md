# Upgrade & Migration Script Usage

Step-by-step guide for running the v0.8.5 upgrade and migration scripts. Covers both direct Safe execution and timelock-guarded flows.

## Configuration

All scripts read from `scripts/upgrade/config/upgrade.json`. Copy the sample and fill in values:

```bash
cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade.json
```

### Config fields

| Field | Required | Description |
|-------|----------|-------------|
| `diamondAddress` | Yes | The Symmio core diamond proxy address being upgraded |
| `protocolAdmin` | Yes | The address that **receives operational roles** (PAUSER, UNPAUSER, PROTOCOL_CONFIG, COOLDOWN_ADMIN, FEE_ADMIN, INTEGRATION_ADMIN) and **owns peripheral contracts** (AccountLayer, InstantLayer). Typically the main multisig. |
| `safeAddress` | Yes (Safe path) | The Safe multisig wallet that **signs and sends** transactions. Used as `createdFromSafeAddress` in Safe batch metadata. |
| `timelockAddress` | Yes (timelock path) | The TimelockController contract that gates diamondCut execution. Only used by `generateTimelockBatch.ts`. |
| `migrationRunner` | Yes | The address that receives `MIGRATION_ROLE` and executes migration transactions. Can be an EOA or the multisig. Falls back to `protocolAdmin` if omitted. |
| `diamondCutChunkSize` | No | Max facet cuts per diamondCut call (default: 1000) |
| `subgraphEndpoint` | No | Goldsky/TheGraph endpoint for fetching open quotes and PartyB balances |
| `spotCheckCount` | No | Number of random on-chain spot-checks during migration input validation |
| `symmioFeeReceiver` | No | Fee receiver address for AccountLayer init |
| `symmioPartyBAddress` | No | Existing SymmioPartyB proxy address (for UUPS upgrade + InstantLayer registration) |
| `newV085Parameters` | No | New parameter values to set during upgrade (see sample) |

### Key distinction: `protocolAdmin` vs `safeAddress` vs `timelockAddress`

These three addresses serve different roles in the upgrade flow:

- **`protocolAdmin`** -- Who **controls** the protocol. This address receives all operational roles on the diamond and owns the peripheral contracts. In most deployments, this is the **main multisig**.

- **`safeAddress`** -- Who **signs** the transactions. This is the Safe wallet used for transaction batching. Often the same address as `protocolAdmin`, but it's a separate concern (execution vehicle vs authority).

- **`timelockAddress`** -- What **delays** the diamondCut. The TimelockController that enforces a waiting period before the diamondCut can be applied. The multisig proposes (schedule) and later executes through the timelock. The timelock is NOT the protocol admin -- it's a delay mechanism only.

**Common mistake**: Setting `protocolAdmin` to the timelock address. The timelock only wraps the diamondCut. Operational roles (pause, unpause, config changes) should go to the multisig, not the timelock.

### Environment variable overrides

Every config field can be overridden via environment variables:

| Env var | Overrides |
|---------|-----------|
| `PROTOCOL_ADMIN` | `protocolAdmin` (also accepts deprecated `ADMIN_ADDRESS`) |
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `SAFE_ADDRESS` | `safeAddress` |
| `TIMELOCK_ADDRESS` | `timelockAddress` |
| `MIGRATION_RUNNER` | `migrationRunner` |
| `UPGRADE_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/upgrade.json`) |

## Upgrade Paths

### Path A: Timelock + Safe (production)

For networks where a TimelockController guards the diamondCut.

### Path B: Direct Safe (no timelock)

For networks where the Safe can call diamondCut directly.

### Path C: EOA (testing / localhost)

For local development or fork testing.

---

## Scripts (in execution order)

### 1. Deploy facets

```bash
npx hardhat run scripts/upgrade/deployFacets.ts --network <network>
```

Deploys all v0.8.5 facet contracts and libraries. Resume-safe via state file (`output/deployed-facets.json`).

### 2. Deploy peripherals

```bash
npx hardhat run scripts/upgrade/deployPeripherals.ts --network <network>
```

Deploys AccountLayer Diamond, InstantLayer, and SymmioPartyB implementation. Resume-safe. Requires `protocolAdmin` and `symmioFeeReceiver`.

Output: `output/deployed-peripherals.json`

### 3. Verify deployments

Run immediately after steps 1 and 2, before signing anything on-chain.

**Block explorer verification** -- verifies source for all libraries, facets, and peripherals (AccountLayer, InstantLayer, SymmioPartyB impl). Reads addresses from `output/deployed-facets.json` and `output/deployed-peripherals.json`:

```bash
NETWORK=<network> bash scripts/upgrade/verify-all.sh
```

**Local-vs-on-chain bytecode verification** -- compares deployed bytecode against locally compiled artifacts. `verifyDeploy.ts` is library-linking aware for core facets; `verifyPeripheralsDeploy.ts` also masks immutable variables for the peripherals:

```bash
RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyDeploy.ts
RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripheralsDeploy.ts
```

`verifyPeripheralsDeploy.ts` also picks up the `MuonSignatureVerifier` address from `upgrade.json` (`newV085Parameters.signatureVerifierAddress`).

### 4. Generate Safe batch

```bash
npx hardhat run scripts/upgrade/generateSafeBatch.ts --network <network>
```

Builds the upgrade transaction set by diffing the live diamond against deployed facets. Automatically loads peripheral addresses from step 2 output.

Output:
- `output/safe-batch.json` -- Safe Transaction Builder JSON (roles, pause, config, wiring)
- `output/diamondcut-calldata.json` -- Raw diamondCut calldata (separate from Safe batch)
- `output/upgrade-details.json` -- Full breakdown of all transactions and selector changes

The Safe batch includes:
1. Grant PAUSER_ROLE and UNPAUSER_ROLE to `protocolAdmin`
2. `pauseGlobal()`
3. Grant PROTOCOL_CONFIG_ROLE, COOLDOWN_ADMIN_ROLE, FEE_ADMIN_ROLE to `protocolAdmin`
4. Set v0.8.5 parameters
5. Grant MIGRATION_ROLE and SYMBOL_MANAGER_ROLE to `migrationRunner`
6. Peripheral wiring (roles + hooks between Diamond, AccountLayer, InstantLayer)

The diamondCut is **not** in the Safe batch -- it's separate so it can be routed through the timelock.

### 5. Generate timelock batches (Path A only)

```bash
npx hardhat run scripts/upgrade/generateTimelockBatch.ts --network <network>
```

Wraps the diamondCut calldata from step 4 into two Safe batches:

Output:
- `output/timelock-schedule-safe-batch.json` -- Calls `TimelockController.schedule()` on the timelock
- `output/timelock-execute-safe-batch.json` -- Calls `TimelockController.execute()` on the timelock

Both target the **timelock contract**, not the diamond directly. The Safe signs these transactions as the timelock proposer/executor.

### 6. Prepare migration input

```bash
npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network <network>
```

Critical-path script: kept short and reliable so it can run during the pause window. Four steps:
1. Fetch open quotes from subgraph
2. Fetch PartyB balances from subgraph
3. Validate boundary against on-chain `getNextQuoteId()`
4. Build the migration input file

Output:
- `output/migration-input.json` -- Quote IDs, PartyB tasks, expected aggregates
- `output/prepareMigrationInput-report.json` -- Step-by-step report

### 7. Validate migration input (optional)

```bash
npx hardhat run scripts/upgrade/validateMigrationInput.ts --network <network>
```

Spot-checks the migration input against on-chain state. Version-agnostic — can be run before or after the upgrade is applied.

### 7b. Prepare symbol types input (off the critical path)

```bash
npx hardhat run scripts/upgrade/prepareSymbolTypes.ts --network <network>
```

Fetches all symbol IDs and names from the subgraph and writes the input file for `setSymbolTypes.ts`. The `symbolType` value (applied to all symbols) is read from `newV085Parameters.symbolType` in `upgrade.json`.

**Run this OUTSIDE the pause window** -- it only hits the subgraph and writes a local file. `setSymbolTypes.ts` consumes its output and does not re-fetch.

Output: `output/symbol-types-input.json`

### 7c. Snapshot on-chain balances (optional, off the critical path)

```bash
npx hardhat run scripts/upgrade/snapshotBalances.ts --network <network>
```

Captures total deposits + allocated balances per PartyA / PartyB for sanity-checking the protocol's total funds before vs after the upgrade. Reads `migration-input.json`, re-fetches PartyB balance entries from the subgraph, and queries the diamond with bounded concurrency and per-call retry/backoff (configurable via `SNAPSHOT_CONCURRENCY` and `SNAPSHOT_MAX_RETRIES`).

**Run this OUTSIDE the pause window** -- it does ~2 RPC calls per PartyA and is the first thing to suffer when an RPC endpoint is flaky. It is not on the migration critical path; `runMigration.ts` does not consume its output.

Output: `output/balance-snapshot.json`

### 8. Run migration (after upgrade is live)

```bash
npx hardhat run scripts/upgrade/runMigration.ts --network <network>
```

Executes `migrateQuotes()` and `migrateCrossLockedValues()` on the paused diamond. Requires `MIGRATION_ROLE`. Resume-safe via progress file.

Output: `output/migration-report.json`

### 8b. Set symbol types

```bash
npx hardhat run scripts/upgrade/setSymbolTypes.ts --network <network>
```

Reads `output/symbol-types-input.json` (produced by `prepareSymbolTypes.ts`) and calls `setSymbolTypes()` on the diamond to backfill the `symbolType` for all symbols. Requires `SYMBOL_MANAGER_ROLE` (granted to `migrationRunner` in the Safe batch).

Can run in parallel with or immediately after `runMigration.ts` -- both require only their respective roles and are independent of each other.

Output: `output/set-symbol-types-report.json`

### 9. Generate post-migration batch

```bash
npx hardhat run scripts/upgrade/generatePostMigrationBatch.ts --network <network>
```

Generates the final transaction set to unpause the system and optionally enable cross-PartyB mode. No on-chain dependency -- can be generated at any time.

The batch always begins with role revocation before unpausing:
1. `revokeRole(MIGRATION_ROLE, migrationRunner)`
2. `revokeRole(SYMBOL_MANAGER_ROLE, migrationRunner)`
3. `unpauseGlobal()`
4. `setCrossPartyBModeActivated(true)` + per-PartyB `setCrossPartyB()` (if `partyBs` list is configured)

`migrationRunner` is resolved from env `MIGRATION_RUNNER` → `postMigration.json` → `upgrade.json`.

Config: `scripts/upgrade/config/postMigration.json` (optional, for PartyB list)

Output:
- `output/post-migration-transactions.json` -- Raw calldata
- `output/post-migration-safe-batch.json` -- Safe Transaction Builder JSON

### 10. Verify upgrade & wiring

Run **after** the wiring batch (`safe-batch.json`) has been executed by the multisig, before unpausing.

```bash
npx hardhat run scripts/upgrade/verifyDiamond.ts --network <network>
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network <network>
```

- `verifyDiamond.ts` -- confirms all v0.8.5 facet selectors are registered on the diamond.
- `verifyPeripherals.ts` -- confirms AccountLayer + InstantLayer roles, hooks, whitelist, and templates are wired correctly.

This is distinct from step 3 (deployment verification): step 3 checks the bytecode of the new contracts, this step checks that the upgrade transactions were applied correctly on-chain.

---

## Execution Flow: Timelock Path

```
Phase 1: Prepare (can be done in advance, no downtime)
  deployFacets.ts
  deployPeripherals.ts
  -> Verify deployments:
       verify-all.sh                  (block explorer source verification)
       verifyDeploy.ts                (core facets bytecode + library linking)
       verifyPeripheralsDeploy.ts     (peripherals bytecode + immutables)
  generateSafeBatch.ts
  generateTimelockBatch.ts
  generatePostMigrationBatch.ts
  prepareSymbolTypes.ts              (off critical path — fetch symbols from subgraph)
  snapshotBalances.ts                (optional pre-pause snapshot, off critical path)

Phase 2: Schedule (multisig signs)
  Import timelock-schedule-safe-batch.json into Safe TX Builder
  -> Queues the diamondCut in the timelock

Phase 3: Wait
  Timelock delay elapses (e.g. 3 days)

Phase 4: Execute upgrade (multisig signs, downtime starts)
  Import pause-safe-batch.json into Safe TX Builder
  -> Grants PAUSER/UNPAUSER, calls pauseGlobal()  <-- DOWNTIME STARTS
  prepareMigrationInput.ts           (after pause, before diamondCut — subgraph + boundary check)
  validateMigrationInput.ts          (optional on-chain spot-check)
  Import timelock-execute-safe-batch.json into Safe TX Builder
  -> Applies the diamondCut through the timelock
  Import safe-batch.json into Safe TX Builder
  -> Grants roles, sets parameters, wires peripherals
  -> Verify upgrade & wiring:
       verifyDiamond.ts               (all v0.8.5 selectors registered)
       verifyPeripherals.ts           (AL/IL roles, hooks, whitelist, templates)

Phase 5: Migrate (EOA with MIGRATION_ROLE / SYMBOL_MANAGER_ROLE)
  runMigration.ts
  -> Migrates quotes and PartyB locked values on the paused system
  setSymbolTypes.ts
  -> Backfills symbolType for all symbols (reads symbol-types-input.json)

Phase 6: Unpause (multisig signs)
  Import post-migration-safe-batch.json into Safe TX Builder
  -> Revoke MIGRATION_ROLE + SYMBOL_MANAGER_ROLE from migrationRunner
  -> Unpause + optional cross-PartyB activation
```

## Execution Flow: Direct Safe Path

Same as above but skip `generateTimelockBatch.ts` and include the diamondCut directly in the Safe batch (the script handles this automatically when no timelock is configured). The verification points are unchanged: verify deployments after `deployFacets.ts` + `deployPeripherals.ts`, and verify upgrade & wiring after the Safe batch is executed.

## Verification Cheat Sheet

| Script | When | Purpose |
|--------|------|---------|
| `verify-all.sh` | After deploy facets + peripherals | Block-explorer source verification of libraries, facets, and peripherals |
| `verifyDeploy.ts` | After deploy facets | Compare local-compiled bytecode vs deployed core facets (library-link aware) |
| `verifyPeripheralsDeploy.ts` | After deploy peripherals | Same, for AccountLayer / InstantLayer / SymmioPartyB impl / MuonSignatureVerifier (handles immutables) |
| `verifyDiamond.ts` | After `safe-batch.json` is executed | All v0.8.5 facet selectors registered on the diamond |
| `verifyPeripherals.ts` | After `safe-batch.json` is executed | AccountLayer + InstantLayer roles, hooks, whitelist, templates wired correctly |

## Output Files Reference

| File | Producer | Consumer |
|------|----------|----------|
| `deployed-facets.json` | deployFacets.ts | generateSafeBatch.ts |
| `deployed-peripherals.json` | deployPeripherals.ts | generateSafeBatch.ts |
| `safe-batch.json` | generateSafeBatch.ts | Safe TX Builder |
| `diamondcut-calldata.json` | generateSafeBatch.ts | generateTimelockBatch.ts |
| `upgrade-details.json` | generateSafeBatch.ts | Human review |
| `timelock-schedule-safe-batch.json` | generateTimelockBatch.ts | Safe TX Builder |
| `timelock-execute-safe-batch.json` | generateTimelockBatch.ts | Safe TX Builder |
| `migration-input.json` | prepareMigrationInput.ts | runMigration.ts |
| `prepareMigrationInput-report.json` | prepareMigrationInput.ts | Human review |
| `symbol-types-input.json` | prepareSymbolTypes.ts | setSymbolTypes.ts |
| `balance-snapshot.json` | snapshotBalances.ts | Human review (sanity-check totals) |
| `migration-report.json` | runMigration.ts | Human review |
| `set-symbol-types-report.json` | setSymbolTypes.ts | Human review |
| `post-migration-transactions.json` | generatePostMigrationBatch.ts | EOA execution |
| `post-migration-safe-batch.json` | generatePostMigrationBatch.ts | Safe TX Builder |

---

## Local E2E Test

```bash
npx hardhat run scripts/upgrade/localE2ETest.ts
```

Runs the full upgrade and migration pipeline against the in-process Hardhat network -- no RPC, no subgraph, no config files required. Completes in ~6 seconds.

**What it exercises:**

| Step | Helper function |
|------|----------------|
| Deploy 28 core facets + libraries | `deployFacets()` |
| Diff live diamond vs new facets | `buildDiamondCut()` |
| Apply diamond cut (381 Replace actions, 5 chunks) | `applyDiamondCut()` |
| Deploy fresh AccountLayer Diamond | `deployAccountLayerDiamond()` |
| Deploy fresh InstantLayer | `deployInstantLayer()` |
| Wire peripherals to diamond | `wireAccountLayerInstantLayer()` |
| Register InstantOpen / InstantClose / InstantCloseWithAllocation templates | `setupInstantLayerTemplates()` |
| Build migration input from on-chain state (no subgraph) | inline loop over `getNextQuoteId()` |
| Migrate quotes + PartyB balances | `migrate()` |
| Verify selectors, system hook, AL roles, IL templates | inline checks |
| Revoke roles, unpause, post-upgrade smoke test | inline |

**What it does NOT cover:**

- `prepareMigrationInput.ts` (subgraph path) -- tested manually against a live network
- `generateSafeBatch.ts` / `generateTimelockBatch.ts` -- require a live RPC to diff the diamond
- Block-explorer source verification (`verify-all.sh`, `verifyDeploy.ts`, `verifyPeripheralsDeploy.ts`)
- Timelock schedule/execute flow

**Self-upgrade note:** Because Hardhat's `deployDiamond` already deploys a full v0.8.5 system, the diamond cut produces all-Replace actions (same selectors, fresh contract addresses). This still exercises the full cut mechanism and all migration logic.

**Known quirk:** `ViewFacetQuote.getNextQuoteId()` returns the **last assigned** quote ID, not the next available one. The test builds migration input with `for id = 1 to lastId` (inclusive) to avoid missing the highest ID.
