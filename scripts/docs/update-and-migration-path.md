# Update And Migration Path (v0.8.4 -> v0.8.5)

This document separates:
- **Update path**: contract code upgrade (`diamondCut`) and post-upgrade invariant checks.
- **Migration path**: data backfill to new v0.8.5 storage structures.

Use this for local rehearsal with two worktrees and one local node.

## 1) Prepare Worktrees (Node Download Optimization)

From repo root:

```bash
git worktree add .worktree-version_0.8.4 origin/version_0.8.4
git worktree add .worktree-version_0.8.5 version_0.8.5
```

Install dependencies once in root, then reuse in worktrees (example with symlink):

```bash
ln -s ../node_modules .worktree-version_0.8.4/node_modules
ln -s ../node_modules .worktree-version_0.8.5/node_modules
```

## 2) Start Local Node

In a dedicated terminal:

```bash
npx hardhat node
```

## 3) Phase A: Deploy + Seed v0.8.4 State

In `.worktree-version_0.8.4`:

```bash
python3 utils/update_sig_checks.py 1
ADMIN_PUBLIC_KEY=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  npx hardhat run ./scripts/initializeUpgradeTest.ts --network localhost | tee ./scripts/output/initializeUpgradeTest.log
python3 utils/update_sig_checks.py 0
```

Collect diamond address for next phase:

```bash
jq -r '.addresses.diamond' ./scripts/output/initializeUpgradeTest-report.json
```

## 4) Phase B: Update to v0.8.5 (diamondCut + Verification)

In `.worktree-version_0.8.5`:

```bash
python3 utils/update_sig_checks.py 1
DIAMOND_ADDRESS=<diamond_from_phase_A> \
  npx hardhat run ./scripts/upgradeTest.ts --network localhost | tee ./scripts/output/upgradeTest.log
python3 utils/update_sig_checks.py 0
```

Default JSON outputs:
- `./scripts/output/upgradeTest-report.json`
- `./scripts/output/upgradeTest-diamond-cut.json`
- `./scripts/output/upgradeTest-progress.json` (resume file, normally removed on success)

## 5) Phase C: Migration Path (Run When Ready)

Migration is a separate step after upgrade. It backfills:
- aggregated quote/position/funding data
- cross PartyB locked values (master bucket)

Run in `.worktree-version_0.8.5`:

```bash
DIAMOND_ADDRESS=<diamond_from_phase_A> \
MIGRATE_PROGRESS_FILE=./scripts/output/migration-progress.json \
MIGRATE_REPORT_FILE=./scripts/output/migrateOnDemand-report.json \
  npx hardhat run ./scripts/migrateOnDemand.ts --network localhost | tee ./scripts/output/migrateOnDemand.log
```

Notes:
- `migrateOnDemand.ts` performs on-chain verification at the end.
- Progress is resumable from `MIGRATE_PROGRESS_FILE`.
- A structured run report is written to `MIGRATE_REPORT_FILE`.
- On full success, underlying migration flow removes the progress file.

## 6) Fork Rehearsal (Live Network State)

For rehearsing the upgrade on real mainnet state without affecting the live network.
See the full guide: [Fork Upgrade Guide](./fork-upgrade-guide.md).

### Quick Start

Terminal 1:

```bash
npx hardhat node --network fork-arbitrum
```

Terminal 2 -- three separate steps (mirrors production):

```bash
# Step 1: Upgrade (impersonates admin, pauses, diamondCut, sets params)
DIAMOND_ADDRESS=0x... npx hardhat run scripts/forkUpgrade.ts --network localhost

# Step 2: Prepare migration input (fetches from subgraph, validates against on-chain)
DIAMOND_ADDRESS=0x... npx hardhat run scripts/prepareMigrationInput.ts --network localhost

# Step 3: Migrate (runs migration + verification using validated input)
DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/output/migration-input.json \
  npx hardhat run scripts/migrateOnDemand.ts --network localhost
```

### How It Works

- Forks the live chain state lazily (only fetches storage slots as accessed)
- Impersonates the real diamond owner via `hardhat_impersonateAccount`
- Upgrade and migration are separate steps (mirrors production where multisig upgrades, then migration runs after subgraph syncs)
- Migration input is fetched from the subgraph and validated against on-chain state before use
- No transactions touch the real network

### Configuration

Copy and edit: `scripts/config/forkUpgrade.sample.json` -> `scripts/config/forkUpgrade.json`

See `newV085Parameters` for configurable v0.8.5 parameter initialization.

### Output

- `scripts/output/forkUpgrade-report.json`
- `scripts/output/migration-input.json` (validated migration data)
- `scripts/output/migrateOnDemand-report.json`

## 7) Acceptance Criteria Per Phase

Phase A (`initializeUpgradeTest-report.json`):
- expected status buckets exist (`PENDING`, `LOCKED`, `OPENED`, `CLOSE_PENDING`, `CLOSED`)
- PartyA/PartyB `connectionMatrix` is populated

Phase B (`upgradeTest-report.json` + `upgradeTest-diamond-cut.json`):
- report `status` is `success`
- step `compare_states` is `ok`
- selector-level `add`/`replace`/`remove` details are present

Phase C (`migrateOnDemand.log` + on-chain checks):
- log ends with `Migration run completed successfully.`
- `migrateOnDemand-report.json` has `status: "success"` and step `verify_migration: ok`
- no migration verification error thrown

## 8) Why Update And Migration Are Separate

`diamondCut` only changes executable code.  
Migration backfills and reshapes existing data so new v0.8.5 read/write paths have complete state.

This separation lets you:
- validate upgrade safety first (`compare_states`)
- execute migration in controlled batches with resume support
