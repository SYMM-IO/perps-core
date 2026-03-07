# Upgrade Output Verification (v0.8.4 -> v0.8.5)

This guide explains how to verify what changed during the local upgrade and how to validate that core state stayed consistent.

## 1) Expected Output Files

Use these defaults unless you override paths with env vars:

| File | Produced by | Purpose |
|---|---|---|
| `<v084-worktree>/scripts/output/initializeUpgradeTest-report.json` | `scripts/initializeUpgradeTest.ts` | Seed dataset summary: addresses, quote statuses, PartyA<->PartyB connection matrix |
| `<v085-worktree>/scripts/output/upgradeTest-report.json` | `scripts/upgradeTest.ts` | Main upgrade verification report (steps + pre/post checks) |
| `<v085-worktree>/scripts/output/upgradeTest-diamond-cut.json` | `scripts/upgradeTest.ts` | Selector-level diff for `diamondCut` (`add` / `replace` / `remove`) |
| `<v085-worktree>/scripts/output/upgradeTest-progress.json` | `scripts/upgradeTest.ts` | Resume state (deleted on success unless `KEEP_PROGRESS=true`) |
| `<v085-worktree>/scripts/output/migrateOnDemand-report.json` | `scripts/migrateOnDemand.ts` | Migration run report (steps + migration summary + verification checks) |

## 2) Verify Initialization Dataset (v0.8.4)

Check the seeded states:

```bash
jq '.statusBuckets' .worktree-version_0.8.4/scripts/output/initializeUpgradeTest-report.json
```

You should see buckets for:
- `PENDING`
- `LOCKED`
- `OPENED`
- `CLOSE_PENDING`
- `CLOSED`

Check PartyA/PartyB interconnections:

```bash
jq '.connectionMatrix' .worktree-version_0.8.4/scripts/output/initializeUpgradeTest-report.json
```

Liquidation check (if enabled with `CREATE_LIQUIDATED_POSITION=true`):

```bash
jq '{createLiquidatedPosition, liquidationAttemptError, liquidatedQuotes: [.quotes[] | select(.actualStatus=="LIQUIDATED") | .id]}' \
  .worktree-version_0.8.4/scripts/output/initializeUpgradeTest-report.json
```

## 3) Verify Upgrade Success (v0.8.5)

Quick status check:

```bash
jq '{status, error, startedAt, finishedAt, durationMs}' .worktree-version_0.8.5/scripts/output/upgradeTest-report.json
```

Expected:
- `status` is `success`
- `error` is `null` or absent

Step-by-step status:

```bash
jq -r '.steps[] | "\(.name): \(.status)"' .worktree-version_0.8.5/scripts/output/upgradeTest-report.json
```

Critical pass condition:
- `compare_states: ok`

That step confirms key invariants are unchanged across upgrade (quote ids, balances, and key counters checked by the script).

## 4) Identify What Was Added/Removed/Replaced by `diamondCut`

Summary counts:

```bash
jq '.selectorActionCounts' .worktree-version_0.8.5/scripts/output/upgradeTest-diamond-cut.json
```

Interpretation:
- `add`: selector did not exist before, now exists.
- `replace`: selector existed and now points to a new facet implementation.
- `remove`: selector existed before and is removed in v0.8.5.

List removed selectors:

```bash
jq '.selectorChanges[] | select(.action=="remove") | {selector, signature, fromFacetAddress}' \
  .worktree-version_0.8.5/scripts/output/upgradeTest-diamond-cut.json
```

List replaced selectors:

```bash
jq '.selectorChanges[] | select(.action=="replace") | {selector, signature, fromFacetAddress, toFacetAddress, toFacetName}' \
  .worktree-version_0.8.5/scripts/output/upgradeTest-diamond-cut.json
```

List new selectors:

```bash
jq '.selectorChanges[] | select(.action=="add") | {selector, signature, toFacetAddress, toFacetName}' \
  .worktree-version_0.8.5/scripts/output/upgradeTest-diamond-cut.json
```

## 5) Verify Overall System Update from Outputs

Treat the upgrade as verified when all are true:

1. Initialization report has expected status buckets and connection matrix.
2. Upgrade report `status == "success"`.
3. Upgrade step `compare_states` is `ok`.
4. `upgradeTest-diamond-cut.json` exists and action counts match expectations for your release.

If any check fails, inspect:
- `upgradeTest-report.json` -> top-level `error`
- `upgradeTest-report.json` -> failed step details in `.steps[]`
- `initializeUpgradeTest-report.json` -> `liquidationAttemptError` (if liquidation was requested)

## 6) Verify Migration Output (When Migration Is Run)

Quick status check:

```bash
jq '{status, error, startedAt, finishedAt, durationMs}' .worktree-version_0.8.5/scripts/output/migrateOnDemand-report.json
```

Step status:

```bash
jq -r '.steps[] | "\(.name): \(.status)"' .worktree-version_0.8.5/scripts/output/migrateOnDemand-report.json
```

Expected:
- `status` is `success`
- `verify_migration: ok`
