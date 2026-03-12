# Production Upgrade (v0.8.4 -> v0.8.5)

## Overview

The production upgrade has five steps:

1. **Generate upgrade transactions** (`generateUpgradeTxs.ts`) -- deploy facets, build diamondCut calldata
2. **Execute upgrade** -- submit the calldata from any wallet, multisig, or script
3. **Prepare migration input** (`prepareMigrationInput.ts`) -- fetch data from subgraph, validate against on-chain
4. **Run migration** (`runMigration.ts`) -- execute migration + verify
5. **Post-migration** -- unpause, enable cross-PartyB mode

## Prerequisites

- Diamond address on the target network
- Admin account (EOA, multisig, or any contract that can call `diamondCut`)
- Subgraph endpoint synced to current chain state
- Config files:
  ```bash
  cp scripts/upgrade/config/upgrade.sample.json scripts/upgrade/config/upgrade.json
  cp scripts/upgrade/config/prepareMigration.sample.json scripts/upgrade/config/prepareMigration.json
  cp scripts/upgrade/config/migrate.sample.json scripts/upgrade/config/migrate.json
  ```

## Step 1: Generate Upgrade Transactions

Deploys v0.8.5 facets to the target network and generates raw calldata for all upgrade transactions.

```bash
DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... \
  npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network arbitrum

# With Safe batch output (optional)
DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... SAFE_ADDRESS=0x... \
  npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network arbitrum

# Load pre-deployed facets (skip deployment)
DIAMOND_ADDRESS=0x... ADMIN_ADDRESS=0x... FACETS_FILE=./scripts/upgrade/output/deployed-facets.json \
  npx hardhat run scripts/upgrade/generateUpgradeTxs.ts --network arbitrum
```

Output:
- `scripts/upgrade/output/upgrade-transactions.json` -- raw calldata (always)
- `scripts/upgrade/output/safe-batch.json` -- Safe Transaction Builder JSON (if SAFE_ADDRESS set)
- `scripts/upgrade/output/deployed-facets.json` -- deployed contract addresses
- `scripts/upgrade/output/upgrade-details.json` -- selector changes + breakdown

### Transaction breakdown

The generated transactions, in order:

| Phase | Transaction | Purpose |
|-------|------------|---------|
| Pause | `grantRole(PAUSER_ROLE)` | Allow admin to pause |
| Pause | `grantRole(UNPAUSER_ROLE)` | Allow admin to unpause later |
| Pause | `pauseGlobal()` | Pause the system |
| Upgrade | `diamondCut(chunk 1)` ... `diamondCut(chunk N)` | Apply code upgrade |
| Params | `grantRole(PROTOCOL_CONFIG_ROLE)` | Allow param setting |
| Params | `grantRole(COOLDOWN_ADMIN_ROLE)` | Allow cooldown setting |
| Params | `setMaxPartyAConnectionLimit(value)` | Required for migration |
| Params | `setSettlementCooldown(value)` | New v0.8.5 param |
| Params | `setDeallocateDebounceTime(value)` | New v0.8.5 param |
| Migration | `grantRole(MIGRATION_ROLE)` | Allow migration runner |

### Using the calldata

**From any wallet/script:**
Each entry in `upgrade-transactions.json` has `to`, `value`, and `calldata` fields. Submit each as a regular transaction:
```typescript
for (const tx of transactions) {
    await signer.sendTransaction({ to: tx.to, value: tx.value, data: tx.calldata })
}
```

**From Gnosis Safe:**
Import `safe-batch.json` into the Safe Transaction Builder UI.

**From another multisig:**
Use the raw calldata from `upgrade-transactions.json` with your multisig's interface.

## Step 2: Execute Upgrade

Submit the generated transactions using your preferred method. All transactions must execute in order.

After execution, the system is **paused and upgraded** but data is **not yet migrated**.

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
- **Phase 2: PartyB balance migration** -- calls `migrateCrossLockedValues()` per PartyB (aggregates per-PartyA balances into cross bucket)
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

After `migration-report.json` shows `"status": "success"`:

1. **Unpause the system** -- call `unpauseGlobal()` via admin
2. **Enable cross-PartyB mode** -- for each PartyB, call `setCrossPartyB(partyB, true)` via admin
3. **Clean up** -- delete `migration-progress.json` if present

## Verification

```bash
jq '{status, error}' scripts/upgrade/output/migration-report.json
```

The migration report includes:
- `quoteChecks` -- number of quotes verified as migrated
- `partyBChecks` -- number of PartyBs with verified master balances
- `aggregateChecks` -- number of aggregated position entries verified

## Configuration

See [fork-rehearsal.md](fork-rehearsal.md) for full config reference tables. Summary:

| Config file | Script | Key fields |
|-------------|--------|------------|
| `upgrade.json` | `generateUpgradeTxs.ts` | `diamondAddress`, `adminAddress`, `newV085Parameters` |
| `prepareMigration.json` | `prepareMigrationInput.ts` | `diamondAddress`, `subgraphEndpoint` |
| `migrate.json` | `runMigration.ts` | `diamondAddress`, `migrationInputFile`, `chunkSize` |

## Troubleshooting

**"maxPartyAConnectionLimit" error during migration**
Set `maxPartyAConnectionLimit` in `newV085Parameters` config. Defaults to 0 after upgrade, which blocks migration.

**Subgraph not synced**
Wait for the subgraph to index past the upgrade block before running `prepareMigrationInput.ts`.

**Transaction failures during migration**
The script retries 3x with exponential backoff. Check RPC health, gas balance, and `MIGRATION_ROLE` grant.

**Stuck migration**
Delete `migration-progress.json` and re-run. Already-migrated items are skipped via on-chain checks.
