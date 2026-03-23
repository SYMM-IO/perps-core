# Fork Rehearsal

Rehearse the full v0.8.4 -> v0.8.5 upgrade + migration on a fork of a live network without touching the real chain.

## Overview

The fork rehearsal mirrors the production flow with three separate steps:

1. **Upgrade** (`forkUpgrade.ts`) -- impersonate admin, pause, deploy facets, diamondCut, set params, deploy AccountLayer + InstantLayer, wire integrations
2. **Prepare migration input** (`prepareMigrationInput.ts`) -- fetch from subgraph, validate against on-chain
3. **Migrate** (`runMigration.ts`) -- run migration + verify using the validated input

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
    allowUnlimitedContractSize: true,
    hardfork: "shanghai",
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

Deploys v0.8.5 facets, applies diamondCut, sets parameters, deploys AccountLayer Diamond + InstantLayer, and wires all integrations on the fork (impersonates diamond owner).

```bash
# Terminal 2
npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost
```

Output: `scripts/upgrade/output/forkUpgrade-report.json`, `deployed-facets.json`, `deployed-accountlayer-instantlayer.json`

### Step 1.5: Verify upgrade

Run after forkUpgrade to confirm the upgrade is correct before migration. All scripts auto-load addresses from `upgrade.json` and output files.

```bash
# Verify all v0.8.5 facet selectors are registered
npx hardhat run scripts/upgrade/verifyDiamond.ts --network localhost

# Verify AccountLayer + InstantLayer wiring (roles, hooks, templates)
npx hardhat run scripts/upgrade/verifyPeripherals.ts --network localhost

# End-to-end: affiliate, sub-account, PartyB upgrade, EIP-712 delegation, template execution
FORK=true npx hardhat run scripts/upgrade/testTemplateExecution.ts --network localhost
```

| Script | What it checks |
|--------|---------------|
| `verifyDiamond.ts` | All v0.8.5 facet selectors registered on diamond |
| `verifyPeripherals.ts` | AccountLayer + InstantLayer roles, hooks, whitelist, templates |
| `testTemplateExecution.ts` | Full trade flow via InstantLayer template (sendQuote -> lockQuote -> openPosition) with EIP-712 signatures, delegation, and result injection |

### Step 2: Prepare migration input

Fetches open quotes and partyB balances from the subgraph, validates them against on-chain state (boundary check, spot-checks, balance verification), and writes a validated JSON file.

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
- `quotes(where: { quoteStatus_in: [4, 6, 7] })` -- all open quotes (OPENED, CLOSE_PENDING, CANCEL_CLOSE_PENDING)
- `latestAccountBalances(where: { accountType: "PARTY_B", counterParty_not: null })` -- partyB-per-partyA balance entries

**Validation against on-chain:**
- Boundary check: on-chain `getNextQuoteId()` must exceed the max subgraph quoteId
- Quote spot-check: random sample of quotes verified against `getQuote()` on-chain (status, partyA, partyB, symbolId)
- Balance spot-check: random sample of partyB allocated balances verified against `allocatedBalanceOfPartyB()` on-chain

Default subgraph endpoint: `https://api.goldsky.com/api/public/project_cm1hfr4527p0f01u85mz499u8/subgraphs/arbitrum_analytics/stage/gn`

Override with `SUBGRAPH_ENDPOINT` env var.

## Configuration

Copy and edit the sample configs:

```bash
cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade.json
cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json
cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate.json
```

### Upgrade config (`upgrade.json`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `diamondAddress` | string | -- | Diamond proxy address on the target network |
| `adminAddress` | string | `""` | Address that receives role grants |
| `safeAddress` | string | `""` | Gnosis Safe address (optional, for Safe path) |
| `migrationRunner` | string | `""` | Address granted MIGRATION_ROLE (defaults to adminAddress) |
| `diamondCutChunkSize` | number | `1000` | Max facet cuts per transaction |
| `symmioFeeReceiver` | string | `""` | Fee receiver for AccountLayer Init (defaults to admin) |
| `setupInstantLayerTemplates` | boolean | `true` | Setup OpenPosition/ClosePosition templates on InstantLayer |
| `symmioPartyBAddress` | string | `""` | Existing SymmioPartyB proxy address (for UUPS upgrade + InstantLayer registration) |
| `newV085Parameters` | object | -- | New v0.8.5 parameters to initialize (see below) |

### Upgrade env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `ADMIN_ADDRESS` | `adminAddress` |
| `DIAMOND_CUT_CHUNK_SIZE` | `diamondCutChunkSize` |
| `SUBGRAPH_ENDPOINT` | `subgraphEndpoint` |
| `UPGRADE_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/upgrade.json`) |

### Prepare migration config (`prepareMigration.json`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `diamondAddress` | string | -- | Diamond proxy address |
| `subgraphEndpoint` | string | Goldsky stage | Subgraph GraphQL endpoint |
| `spotCheckCount` | number | `20` | Number of quotes/balances to spot-check |
| `outputDir` | string | `scripts/upgrade/output` | Output directory |
| `outputFile` | string | `scripts/upgrade/output/migration-input.json` | Output file path |

### Prepare migration env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `SUBGRAPH_ENDPOINT` | `subgraphEndpoint` |
| `SPOT_CHECK_COUNT` | `spotCheckCount` |
| `PREPARE_OUTPUT_FILE` | `outputFile` |
| `PREPARE_MIGRATION_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/prepareMigration.json`) |

### Migration config (`migrate.json`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `diamondAddress` | string | -- | Diamond proxy address |
| `migrationInputFile` | string | -- | Path to validated input JSON (required) |
| `chunkSize` | number | `50` | Items per migration transaction (quotes and partyAs) |
| `dryRun` | boolean | `false` | Log operations without executing |
| `fork` | boolean | `false` | Impersonate diamond owner instead of using deployer signer |
| `strict` | boolean | `false` | Stop on any failure |
| `progressFile` | string | `scripts/upgrade/output/migration-progress.json` | Resume file path |
| `reportFile` | string | `scripts/upgrade/output/migration-report.json` | Report file path |

### Migration env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `MIGRATION_INPUT_FILE` | `migrationInputFile` |
| `MIGRATE_CHUNK_SIZE` | `chunkSize` |
| `DRY_RUN` | `dryRun` |
| `FORK` | `fork` |
| `MIGRATE_STRICT` | `strict` |
| `MIGRATION_CONFIG_FILE` | Config file path (default: `scripts/upgrade/config/migrate.json`) |

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

**"execution reverted" on diamondCut**
The impersonated account may not be the actual owner. Check `ViewFacet.owner()` on the target network. If it returns a multisig (e.g., Gnosis Safe), use `ADMIN_ADDRESS` to override with the actual EOA that controls the multisig, or impersonate the multisig address directly.

**Migration fails with "maxPartyAConnectionLimit" error**
Set `maxPartyAConnectionLimit` in `newV085Parameters` (defaults to 0 after upgrade, which blocks `addConnection()`).

**Subgraph validation fails**
The subgraph may not be synced to the fork block. Ensure the subgraph is up to date before running `prepareMigrationInput.ts`. Check the spot-check error message -- it tells you which field mismatched and whether the subgraph is stale.
