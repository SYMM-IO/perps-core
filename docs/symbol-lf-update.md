# Update symbol LF minimums

Run `./symmio`, choose **Other maintenance scripts**, then **Update symbol LF minimums**.
The task updates one deployment per run through its existing Symbol Manager. Base v0.8.5
is the first selection. Presets also cover the supplied Arbitrum v0.8.5, Arbitrum v0.8.6.2,
and BNB v0.8.5 deployments. **Another deployment** accepts a configured network and explicit
Core/manager addresses; presets are not an exhaustive production inventory.

The policy is exactly `30000000000000000` for reviewed BTC/ETH IDs and
`40000000000000000` for all other IDs. The denominator is Party A locked collateral:
`CVA + LF + partyAmm`. Every symbol's existing `minAcceptableQuoteValue` is preserved.
The task includes inactive symbols and duplicate listings, and skips IDs already at target.

## Prerequisites and keystore

The wallet must hold `SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE` on the manager and have
native gas currency. The manager must be unpaused, wired to the correct Core, and hold
Core's `SYMBOL_MANAGER_ROLE`. Its `acceptableValues` quota must have available capacity.
The task checks these conditions; it does not grant roles or change quotas. Execute and
verify the separate Base Safe role/quota batch first if those prerequisites are missing.

Record the solver announcement and agreed enforcement time before executing. The task
asks for their reference and UTC time and persists them with the plan. It refuses writes
before that time. It does not publish or independently verify the announcement.

| Network  | RPC keystore entry | Gas currency |
| -------- | ------------------ | ------------ |
| Base     | `RPC_BASE`         | ETH          |
| Arbitrum | `RPC_ARBITRUM`     | ETH          |
| BNB      | `RPC_BSC`          | BNB          |

Enter the **existing wallet key name** when prompted. `TEAM_DEPLOYER` is only a suggested
name; use the entry whose address holds the role. The task does not replace stored keys,
request raw keys, or export RPC credentials. The shared prompt bridge unlocks the keystore,
reuses the unlock in memory across subprocesses, and clears it when returning to the menu.
A restarted run unlocks again. Task evidence stores public addresses and key names only.
RPC resolution uses the keystore even if the shell has a separate RPC override.

## Review and execute

1. Select the deployment, confirm Core and Symbol Manager addresses, enter the wallet
   address, and choose 1–50 symbols per transaction (default 50).
2. Enter the announcement reference and enforcement time as `YYYY-MM-DDTHH:mm:ssZ`.
3. Enter the existing keystore wallet key name. The task reads a catalog at one pinned
   block and records manager/Core implementation identity, authority, and available quota.
4. Review the suggested BTC/ETH IDs, including duplicates. Unusual names containing BTC
   or ETH are highlighted for classification review. Edit the comma-separated list if
   necessary. Every ID outside that list receives 4%.
5. Review the displayed `preview.csv` and `plan.json` paths. The CSV lists every symbol's
   ID, name, existing quote minimum, and old/target LF in contract units. The screen also
   reports any existing LF values that would **decrease** to the exact policy target.
   Type the chain ID to authorize the reviewed changes.
6. Each batch is simulated and gas-estimated before submission. The task waits for its
   receipt, checks the resulting values, and finishes with a fresh full-catalog comparison.

The only setter used is
`setSymbolAcceptableValuesBatch(symbolIds, existingQuoteMinimums, targetLFs)`.
One symbol consumes one quota unit, independent of transaction count. The quota is shared
with other operators. Gas can require a batch size below 50.

Unexpected quote-minimum or other observed symbol changes stop the run. Concurrent
governance changes between a read and transaction inclusion cannot be prevented by this
setter; coordinate with other symbol operators during the rollout.

## Resume and evidence

Choose **Continue active task** after a quota reset, the enforcement time, or resolving a
transient failure. First Ctrl+C pauses at the next adapter boundary (at most five LF
batches per invocation). Do not edit the reviewed plan or source while a task is active.

The task reconciles recorded hashes before another write and skips symbols already at
target. Unknown transaction outcomes block further writes. Replacement/dropped-transaction
recovery uses the shared journal controls in `cli/README.md`. Cancellation stops future
writes; confirmed changes remain on-chain. Rollback needs a separately reviewed action.

Evidence is under `.symmio/tasks/runs/<task>-<run>/lf-update/`:

- `snapshot.json`: block/hash, original catalog, contract identity, authority/quota check,
  announcement reference, and enforcement time.
- `plan.json` and `preview.csv`: reviewed BTC/ETH IDs, all targets, and planned calldata.
- `report.json`: transaction hashes/receipts, progress, and final symbol reads at the
  recorded verification block/hash.

Back up the run directory. Completion covers its captured catalog; new listings need a
new plan. Catalog changes, unexpected LF values, or implementation changes stop the task
for review. Missing required functions must be escalated for contract review; this workflow
does not upgrade contracts.

## Verification scope

The focused test uses the real local Core and Symbol Manager to check dry runs, partial
execution, quota resets, idempotency, drift/authority checks, and quotes failing just below
or succeeding at the 3%/4% collateral boundary:

```bash
npx hardhat test mocha --no-compile -- test/parallel/LfUpdate.test.ts
```

A matching fork rehearsal is required before declaring a deployment ready. Local/fork
receipts are not production transactions. Production acceptance still requires the real
announcement, transaction references, and fresh on-chain reads for each deployment.
The task changes no position storage, notional LF floor, or liquidation payout logic.
It uses the existing `getSymbols` and acceptable-values interfaces, with optional symbol
type reads where available. Version labels alone do not establish compatibility.
