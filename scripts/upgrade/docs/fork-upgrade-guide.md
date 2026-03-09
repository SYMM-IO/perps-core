# Fork Upgrade Guide

Rehearse the full v0.8.4 -> v0.8.5 upgrade + migration on a fork of a live network without touching the real chain.

## Overview

The fork rehearsal mirrors the production flow with three separate steps:

1. **Upgrade** (`forkUpgrade.ts`) -- impersonate admin, pause, diamondCut, set params
2. **Prepare migration input** (`prepareMigrationInput.ts`) -- fetch from subgraph, validate against on-chain
3. **Migrate** (`migrateOnDemand.ts`) -- run migration + verify using the validated input

In production, step 1 is done by the multisig, followed by a delay for the subgraph to sync, then steps 2 and 3.

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

Impersonates the diamond owner, pauses, deploys v0.8.5 facets, applies diamondCut, sets new parameters.

```bash
# Terminal 2
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost

# With admin override (if owner() returns a multisig)
DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... npx hardhat run scripts/upgrade/forkUpgrade.ts --network localhost
```

Output: `scripts/output/forkUpgrade-report.json`

### Step 2: Prepare migration input

Fetches open quotes and partyB balances from the subgraph, validates them against on-chain state (boundary check, spot-checks, balance verification), and writes a validated JSON file.

```bash
DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost

# With custom subgraph endpoint
DIAMOND_ADDRESS=0x... SUBGRAPH_ENDPOINT=https://... npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network localhost
```

Output: `scripts/output/migration-input.json`

For fork rehearsal, the subgraph data from mainnet is valid because the fork starts from the same state and the system is paused (no state drift).

### Step 3: Migrate

Runs migration using the validated input file, then verifies results on-chain.

```bash
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/output/migration-input.json \
  npx hardhat run scripts/upgrade/migrateOnDemand.ts --network localhost
```

Output: `scripts/output/migrateOnDemand-report.json`

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

Copy and edit the sample config:

```bash
cp scripts/config/forkUpgrade.sample.json scripts/config/forkUpgrade.json
```

### Upgrade config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `diamondAddress` | string | -- | Diamond proxy address on the target network |
| `adminAddress` | string | `""` | Override for admin (if `owner()` returns a multisig) |
| `diamondCutChunkSize` | number | `6` | Max facet cuts per transaction |
| `quoteScanLimit` | number | `500` | Max quote IDs to scan for party discovery |
| `newV085Parameters` | object | -- | New v0.8.5 parameters to initialize (see below) |
| `verbose` | boolean | `false` | Enable verbose logging |

### Upgrade env var overrides

| Env var | Overrides |
|---------|-----------|
| `DIAMOND_ADDRESS` | `diamondAddress` |
| `ADMIN_ADDRESS` | `adminAddress` |
| `DIAMOND_CUT_CHUNK_SIZE` | `diamondCutChunkSize` |
| `QUOTE_SCAN_LIMIT` | `quoteScanLimit` |
| `VERBOSE` | `verbose` |
| `FORK_UPGRADE_CONFIG_FILE` | Config file path (default: `scripts/config/forkUpgrade.json`) |

### Prepare migration input env vars

| Env var | Default | Description |
|---------|---------|-------------|
| `DIAMOND_ADDRESS` | -- | Diamond proxy address |
| `SUBGRAPH_ENDPOINT` | Goldsky stage | Subgraph GraphQL endpoint |
| `SPOT_CHECK_COUNT` | `20` | Number of quotes/balances to spot-check |
| `PREPARE_OUTPUT_FILE` | `scripts/output/migration-input.json` | Output file path |

### Migration env vars

| Env var | Default | Description |
|---------|---------|-------------|
| `DIAMOND_ADDRESS` | -- | Diamond proxy address |
| `MIGRATION_INPUT_FILE` | -- | Path to validated input JSON (required) |
| `MIGRATE_CHUNK_SIZE` | `50` | Quotes per migration transaction |
| `DRY_RUN` | `false` | Log operations without executing |

## newV085Parameters

These are parameters that **only exist in v0.8.5** (not in v0.8.4 storage). After `diamondCut`, they default to 0 and must be initialized.

**Must-set (blocks migration if 0):**
- `maxPartyAConnectionLimit` -- migration calls `addConnection()` which checks this limit

**Should-set (needed for v0.8.5 features to work):**
- `settlementCooldown` -- cross-mode settlement cooldown
- `deallocateDebounceTime` -- safe-deallocate debounce

**Not set here (optional, admin configures post-migration):**
- `signatureVerifierAddress`, `crossPartyBMode`, `ADLEnabled`, `liquidationInsuranceVault`, withdraw params, `unbindCooldown`, etc.

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
