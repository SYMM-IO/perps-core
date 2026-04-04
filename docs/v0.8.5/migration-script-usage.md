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

### 3. Generate Safe batch

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
5. Grant MIGRATION_ROLE to `migrationRunner`
6. Peripheral wiring (roles + hooks between Diamond, AccountLayer, InstantLayer)

The diamondCut is **not** in the Safe batch -- it's separate so it can be routed through the timelock.

### 4. Generate timelock batches (Path A only)

```bash
npx hardhat run scripts/upgrade/generateTimelockBatch.ts --network <network>
```

Wraps the diamondCut calldata from step 3 into two Safe batches:

Output:
- `output/timelock-schedule-safe-batch.json` -- Calls `TimelockController.schedule()` on the timelock
- `output/timelock-execute-safe-batch.json` -- Calls `TimelockController.execute()` on the timelock

Both target the **timelock contract**, not the diamond directly. The Safe signs these transactions as the timelock proposer/executor.

### 5. Prepare migration input

```bash
npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network <network>
```

Fetches open quotes and PartyB balances from the subgraph, builds the migration payload, and takes an on-chain balance snapshot.

Output:
- `output/migration-input.json` -- Quote IDs, PartyB tasks, expected aggregates
- `output/prepareMigrationInput-report.json` -- Step-by-step report with balance snapshot

### 6. Validate migration input

```bash
npx hardhat run scripts/upgrade/validateMigrationInput.ts --network <network>
```

Spot-checks the migration input against on-chain state. Can be run before or after the upgrade is applied.

### 7. Run migration (after upgrade is live)

```bash
npx hardhat run scripts/upgrade/runMigration.ts --network <network>
```

Executes `migrateQuotes()` and `migrateCrossLockedValues()` on the paused diamond. Requires `MIGRATION_ROLE`. Resume-safe via progress file.

Output: `output/migration-report.json`

### 8. Generate post-migration batch

```bash
npx hardhat run scripts/upgrade/generatePostMigrationBatch.ts --network <network>
```

Generates the final transaction set to unpause the system and optionally enable cross-PartyB mode. No on-chain dependency -- can be generated at any time.

Config: `scripts/upgrade/config/postMigration.json` (optional, for PartyB list)

Output:
- `output/post-migration-transactions.json` -- Raw calldata
- `output/post-migration-safe-batch.json` -- Safe Transaction Builder JSON

### 9. Verify

```bash
npx hardhat run scripts/upgrade/verifyDiamond.ts --network <network>
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network <network>
```

Checks on-chain state: facet registrations, role assignments, wiring between Diamond/AccountLayer/InstantLayer.

---

## Execution Flow: Timelock Path

```
Phase 1: Prepare (can be done in advance)
  deployFacets.ts
  deployPeripherals.ts
  generateSafeBatch.ts
  generateTimelockBatch.ts
  prepareMigrationInput.ts
  validateMigrationInput.ts
  generatePostMigrationBatch.ts

Phase 2: Schedule (multisig signs)
  Import timelock-schedule-safe-batch.json into Safe TX Builder
  -> Queues the diamondCut in the timelock

Phase 3: Wait
  Timelock delay elapses (e.g. 3 days)

Phase 4: Execute upgrade (multisig signs both)
  Import timelock-execute-safe-batch.json into Safe TX Builder
  -> Applies the diamondCut through the timelock
  Import safe-batch.json into Safe TX Builder
  -> Pauses system, grants roles, sets parameters, wires peripherals

Phase 5: Migrate (EOA)
  runMigration.ts
  -> Migrates quotes and PartyB locked values on the paused system

Phase 6: Unpause (multisig signs)
  Import post-migration-safe-batch.json into Safe TX Builder
  -> Unpause + optional cross-PartyB activation
```

## Execution Flow: Direct Safe Path

Same as above but skip `generateTimelockBatch.ts` and include the diamondCut directly in the Safe batch (the script handles this automatically when no timelock is configured).

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
| `migration-report.json` | runMigration.ts | Human review |
| `post-migration-transactions.json` | generatePostMigrationBatch.ts | EOA execution |
| `post-migration-safe-batch.json` | generatePostMigrationBatch.ts | Safe TX Builder |
