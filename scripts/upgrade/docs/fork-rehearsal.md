# Fork Rehearsal

Rehearse the full v0.8.4 -> v0.8.5 upgrade + migration on a fork of a live network without touching the real chain.

## Overview

The fork rehearsal mirrors the production flow with three separate steps, or one integrated fork run when `FORK_RUN_MIGRATION=true`:

1. **Upgrade** (`forkUpgrade.ts`) -- impersonate admin, pause, deploy facets, diamondCut, set params, deploy AccountLayer + InstantLayer + SymmioSymbolManager, wire integrations
2. **Prepare migration input** (`prepareMigrationInput.ts`) -- after pause, fetch candidates from subgraph, derive PartyB tasks from on-chain quotes, validate against on-chain
3. **Migrate** (`runMigration.ts`) -- after diamondCut and `MIGRATION_ROLE`, run migration + verify using the validated input

In production, step 1 is done by the admin (EOA via `applyUpgrade.ts`) or multisig (via `generateSafeBatch.ts`), followed by a delay for the subgraph to sync, then steps 2 and 3.

## Prerequisites

- An archive RPC endpoint for the target network (public RPCs may rate-limit fork requests)
- The diamond address on the target network
- Fork network configured in `hardhat.config.ts` (e.g., `fork-arbitrum` already exists)

## Fork Network Configuration

`hardhat.config.ts` already includes a `fork-arbitrum` network. To add more:

```typescript
"fork-base": {
    type: "edr-simulated",
    blockGasLimit: 30_000_000,
    allowUnlimitedContractSize: false,
    hardfork: "cancun",
    forking: {
        url: "https://base.drpc.org",
        blockNumber: Number(process.env.FORK_BLOCK_NUMBER || 0) || undefined,
    },
},
```

Set `FORK_BLOCK_NUMBER` to pin to a specific block (recommended for reproducibility).

## Usage

### Step 0: Start the forked node

```bash
# Terminal 1
npx hardhat node --network fork-arbitrum

# Or pin to a specific block
FORK_BLOCK_NUMBER=250000000 npx hardhat node --network fork-arbitrum
```

### Step 1: Upgrade

Deploys v0.8.5 facets, applies diamondCut, sets parameters, deploys AccountLayer Diamond + InstantLayer + SymmioSymbolManager, and wires all integrations on the fork (impersonates diamond owner).

```bash
# Terminal 2
npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost
```

Output: `scripts/upgrade/output/forkUpgrade-report.json`, `deployed-facets.json`, `deployed-accountlayer-instantlayer.json`, `deployed-symbolmanager.json`

To run the fork upgrade and migration in one rehearsal, enable the migration phase:

```bash
NETWORK_ALIAS=base FORK_RUN_MIGRATION=true GAP_SCAN_RANGE=10 \
  npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost
```

In this mode, `forkUpgrade.ts` prepares and validates the migration input immediately after `pauseGlobal()`, then continues with the diamondCut, wiring, `MIGRATION_ROLE`, and `runMigration.ts`.

For an existing AccountLayer diamond, set `accountLayerDiamondAddress` in the upgrade config or pass
`ACCOUNT_LAYER_DIAMOND_ADDRESS`. The rehearsal then deploys the complete linked AccountLayer facet set,
builds a live loupe diff, applies it through the AccountLayer owner, and records the existing diamond in the report.
If the address is omitted, the historical v0.8.4 -> v0.8.5 path still deploys AccountLayer fresh.

Ownership and configuration authority may be separate. The script resolves the cut signer from live diamond storage;
set `ACCOUNT_LAYER_OWNER` only to override that owner. For post-cut wiring it checks the configured AccountLayer admin,
the core admin, and the AccountLayer owner for both `SIGNER_SETTER_ROLE` admin authority and `SETTER_ROLE`. Set
`ACCOUNT_LAYER_ADMIN` when none of the defaults holds both permissions.

The current release requires Cancun/EIP-1153. Fork profiles use `hardfork: "cancun"` and enforce EIP-170 during
deployment. Do not rehearse an unsupported target by overriding the fork to Cancun and treating that as proof of
target-chain compatibility.

### Step 1.5: Verify upgrade

Run after forkUpgrade to confirm the upgrade is correct before migration. All scripts auto-load addresses from `upgrade.json` and output files.

```bash
# Verify all v0.8.5 facet selectors are registered
npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network localhost

# Verify AccountLayer + InstantLayer wiring (roles, hooks, templates)
npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network localhost

# End-to-end: affiliate, sub-account, PartyB upgrade, EIP-712 delegation, template execution
FORK=true npx hardhat run scripts/upgrade/testTemplateExecution.ts --network localhost
```

| Script                      | What it checks                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyDiamondSelectors.ts` | All v0.8.5 facet selectors registered on diamond                                                                                             |
| `verifyPeripheralWiring.ts` | AccountLayer + InstantLayer roles, hooks, whitelist, templates                                                                               |
| `testTemplateExecution.ts`  | Full trade flow via InstantLayer template (sendQuote -> lockQuote -> openPosition) with EIP-712 signatures, delegation, and result injection |

### Step 2: Prepare migration input

Fetches open quotes from the subgraph after the system is paused, reads the selected quotes from on-chain `getQuote()`, derives PartyB tasks from that paused state, and writes a validated JSON file.

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost

# With custom subgraph endpoint
DIAMOND_ADDRESS=0x... SUBGRAPH_ENDPOINT=https://... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost
```

Output: `scripts/upgrade/output/migration-input.json`

For fork rehearsal, the subgraph data from mainnet is valid because the fork starts from the same state and the system is paused (no state drift).

### Step 3: Migrate

Runs migration using the validated input file, then verifies results on-chain.

```bash
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network localhost
```

Output: `scripts/upgrade/output/migration-report.json`

## How Impersonation Works

1. `resolveOwner(diamondAddress)` -- reads `ViewFacet.owner()` from the forked state
2. `impersonateAndFund(address)` -- calls `hardhat_impersonateAccount` + `setBalance` (100 ETH)
3. The returned signer can call owner-only functions (`diamondCut`, `setAdmin`, `grantRole`)

Facet deployment uses `signers[0]` (anyone can deploy contracts). Only `diamondCut()` requires the owner.

## Subgraph Integration

Migration input is fetched from the Goldsky stage subgraph, not scanned on-chain. This is much faster (a few HTTP requests vs thousands of RPC calls).

**Queries used:**

- `quotes(where: { quoteStatus_in: [0, 1, 2, 4, 5, 6] })` -- quotes needing migration (PENDING, LOCKED, CANCEL_PENDING, OPENED, CLOSE_PENDING, CANCEL_CLOSE_PENDING)
- `latestAccountBalances(where: { accountType: "PARTY_B", counterParty_not: null })` -- partyB-per-partyA balance entries

**Validation against on-chain (`validateMigrationInput.ts`):**

- Boundary check: max subgraph quoteId must not exceed on-chain `getNextQuoteId()` (which returns the last assigned ID)
- Quote spot-check: random sample of quotes verified against `getQuote()` on-chain (status, partyA, partyB, symbolId)
- Balance spot-check: random sample of partyB allocated balances verified against `allocatedBalanceOfPartyB()` on-chain

**Edge case validation (`validateMigrationEdgeCases.ts`):** Particularly important on forks where the subgraph indexes the live chain beyond the fork block:

- Boundary quote: verifies the quote at `lastId` is included if it has a migratable status
- Fork drift: ensures no quoteIds exceed on-chain `lastId` (the subgraph may have quotes created after the fork block)
- Gap scan: scans first and last N quotes on-chain, flags active quotes missing from input
- PartyB completeness: checks for empty `partyAs` arrays and duplicate entries

Default subgraph endpoint: `https://api.goldsky.com/api/public/project_cm1hfr4527p0f01u85mz499u8/subgraphs/arbitrum_analytics/stage/gn`

Override with `SUBGRAPH_ENDPOINT` env var.

## Configuration

Copy and edit the sample configs:

```bash
cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade-<network>.json
cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration-<network>.json
cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate-<network>.json
```

Config files support network-postfixed names (e.g. `upgrade-arbitrum.json`). Scripts try `{name}-{network}.json` first, fall back to `{name}.json`.

### Upgrade config (`upgrade.json`)

| Field                        | Type    | Default | Description                                                                     |
| ---------------------------- | ------- | ------- | ------------------------------------------------------------------------------- |
| `diamondAddress`             | string  | --      | Diamond proxy address on the target network                                     |
| `accountLayerDiamondAddress` | string  | --      | Existing AccountLayer diamond to upgrade in place; omit only for the historical fresh-deploy path |
| `accountLayerOwner`          | string  | live owner | Optional fork-only override for the AccountLayer diamond-cut owner              |
| `accountLayerAdmin`          | string  | discovered | AccountLayer role admin used for post-cut wiring when ownership and role administration differ |
| `protocolAdmin`              | string  | `""`    | Default admin / role admin used for fork role grants and post-cut wiring        |
| `upgradeOperator`            | string  | `""`    | Optional temporary scoped executor for EOA operational rehearsals               |
| `safeAddress`                | string  | `""`    | Gnosis Safe address (optional, for Safe path)                                   |
| `migrationRunner`            | string  | `""`    | Address granted `MIGRATION_ROLE` and impersonated by `runMigration.ts` on forks |
| `diamondCutChunkSize`        | number  | `1000`  | Max facet cuts per transaction                                                  |
| `symmioFeeReceiver`          | string  | `""`    | Fee receiver for AccountLayer Init (defaults to `protocolAdmin`)                |
| `setupInstantLayerTemplates` | boolean | `true`  | Setup OpenPosition/ClosePosition templates on InstantLayer                      |
| `newV085Parameters`          | object  | --      | New v0.8.5 parameters to initialize (see below)                                 |

### Upgrade env var overrides

| Env var                                                       | Overrides                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DIAMOND_ADDRESS`                                             | `diamondAddress`                                                                                          |
| `FORK_OWNER_ADDRESS` / `FORK_ADMIN_ADDRESS` / `ADMIN_ADDRESS` | Explicit diamond owner override; otherwise `forkUpgrade.ts` reads the owner from LibDiamond storage       |
| `ACCOUNT_LAYER_DIAMOND_ADDRESS`                               | `accountLayerDiamondAddress`                                                                              |
| `ACCOUNT_LAYER_OWNER`                                         | `accountLayerOwner`                                                                                       |
| `ACCOUNT_LAYER_ADMIN`                                         | `accountLayerAdmin`                                                                                       |
| `PROTOCOL_ADMIN`                                              | Override `protocolAdmin` for role/default-admin wiring                                                    |
| `FORK_MIGRATION_RUNNER_ADDRESS` / `MIGRATION_RUNNER_ADDRESS`  | Override the fork migration signer granted `MIGRATION_ROLE`                                               |
| `DIAMOND_CUT_CHUNK_SIZE`                                      | `diamondCutChunkSize`                                                                                     |
| `SUBGRAPH_ENDPOINT`                                           | `subgraphEndpoint`                                                                                        |
| `UPGRADE_CONFIG_FILE`                                         | Config file path (default: `scripts/upgrade/config/upgrade-{network}.json`, falls back to `upgrade.json`) |

### Prepare migration config (`prepareMigration.json`)

| Field               | Type     | Default                                       | Description                                                  |
| ------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------ |
| `diamondAddress`    | string   | --                                            | Diamond proxy address                                        |
| `subgraphEndpoint`  | string   | Goldsky stage                                 | Subgraph GraphQL endpoint                                    |
| `subgraphEndpoints` | string[] | `[]`                                          | Ordered fallback list of subgraph endpoints                  |
| `subgraphPageSize`  | number   | `1000`                                        | Subgraph pagination size; lower if gateway requests time out |
| `spotCheckCount`    | number   | `20`                                          | Number of quotes/balances to spot-check                      |
| `outputDir`         | string   | `scripts/upgrade/output`                      | Output directory                                             |
| `outputFile`        | string   | `scripts/upgrade/output/migration-input.json` | Output file path                                             |

### Prepare migration env var overrides

| Env var                         | Overrides                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DIAMOND_ADDRESS`               | `diamondAddress`                                                                                                            |
| `SUBGRAPH_ENDPOINT`             | `subgraphEndpoint`                                                                                                          |
| `SUBGRAPH_ENDPOINTS`            | Comma-separated ordered fallback list of subgraph endpoints. Each retry cycle tries all endpoints before sleeping.          |
| `SUBGRAPH_PAGE_SIZE`            | Subgraph pagination size. Use `500` or `250` if the endpoint returns 504.                                                   |
| `SUBGRAPH_MAX_RETRIES`          | Number of retries per subgraph request before reducing page size or failing.                                                |
| `SPOT_CHECK_COUNT`              | `spotCheckCount`                                                                                                            |
| `PREPARE_OUTPUT_FILE`           | `outputFile`                                                                                                                |
| `PREPARE_MIGRATION_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/prepareMigration-{network}.json`, falls back to `prepareMigration.json`) |

### Migration config (`migrate.json`)

| Field                | Type    | Default                                          | Description                                                           |
| -------------------- | ------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `diamondAddress`     | string  | --                                               | Diamond proxy address                                                 |
| `migrationInputFile` | string  | --                                               | Path to validated input JSON (required)                               |
| `chunkSize`          | number  | `50`                                             | Items per migration transaction (quotes and partyAs)                  |
| `dryRun`             | boolean | `false`                                          | Log operations without executing                                      |
| `fork`               | boolean | `false`                                          | Impersonate diamond owner instead of using deployer signer            |
| `skipPreCheck`       | boolean | `false`                                          | Skip on-chain pre-flight checks (faster, may send no-op transactions) |
| `progressFile`       | string  | `scripts/upgrade/output/migration-progress.json` | Resume file path                                                      |
| `reportFile`         | string  | `scripts/upgrade/output/migration-report.json`   | Report file path                                                      |

### Migration env var overrides

| Env var                 | Overrides                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `DIAMOND_ADDRESS`       | `diamondAddress`                                                                                          |
| `MIGRATION_INPUT_FILE`  | `migrationInputFile`                                                                                      |
| `MIGRATE_CHUNK_SIZE`    | `chunkSize`                                                                                               |
| `DRY_RUN`               | `dryRun`                                                                                                  |
| `FORK`                  | `fork`                                                                                                    |
| `SKIP_PRE_CHECK`        | `skipPreCheck`                                                                                            |
| `MIGRATION_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/migrate-{network}.json`, falls back to `migrate.json`) |

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

Existing v0.8.4 parameters (cooldowns, limits, fee shares, etc.) are preserved in storage and NOT overwritten by this script.

## Troubleshooting

**RPC rate-limiting**
Use a dedicated archive RPC endpoint. Public RPCs may reject fork requests or throttle heavily. Consider Alchemy, Infura, or dRPC with an API key.

**Block number 0 / latest block**
If `FORK_BLOCK_NUMBER` is not set, the fork uses the latest block. This can cause non-deterministic behavior if the chain advances between runs. Pin to a specific block for reproducibility.

**Gas limits**
The fork node uses `blockGasLimit: 30_000_000`. If diamond cut transactions fail with out-of-gas, reduce `diamondCutChunkSize`.

**"LibDiamond: Must be contract owner"**
The impersonated owner is not the actual diamond owner. By default `forkUpgrade.ts` reads the owner from LibDiamond storage and uses it only for owner-only calls (`setAdmin`, `diamondCut`). `protocolAdmin` remains the DEFAULT_ADMIN_ROLE / role-wiring actor. If you need to override the owner, set `FORK_OWNER_ADDRESS`, `FORK_ADMIN_ADDRESS`, or `ADMIN_ADDRESS` to the exact owner address to impersonate.

**Migration fails with "maxPartyAConnectionLimit" error**
Set `maxPartyAConnectionLimit` in `newV085Parameters` (defaults to 0 after upgrade, which blocks `addConnection()`).

**Subgraph validation fails**
The subgraph may not be synced to the fork block. Ensure the subgraph is up to date before running `prepareMigrationInput.ts`. Check the spot-check error message -- it tells you which field mismatched and whether the subgraph is stale.
