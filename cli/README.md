# SYMMIO Operator

Run the checkout-local operator application in an interactive terminal:

```bash
./symmio
```

`./symmio --help` only explains how to launch the application. Every other argument and
non-TTY execution is refused. The CLI executes the checked-in ESM source directly; there is
no generated CLI bundle.

## Home menu

The home menu always contains these actions in this order:

1. Deploy a contract
2. Patch configurations for deployed contracts
3. Run the checklist on a new deployment
4. Other maintenance scripts
5. Continue active task
6. Cancel active task
7. Exit

Continue and cancel remain visible but disabled when no durable task is active. A completed
deployment report under `tasks/data/` is history, not active task state.

The deploy flow uses guided typed fields. It starts from reviewed network defaults, asks
only for required addresses, numeric values, component scope, and overrides, validates each
answer immediately, writes the JSON recipe atomically, and presents the complete grouped
intent for confirmation. Recipes remain portable review artifacts; operators do not need to
edit them by hand.

For the recommended first rehearsal, run a persistent local node in one terminal with
`npx hardhat node`, then launch `./symmio` in another and select **Persistent local Hardhat
node**. `npm run test:cli:e2e` drives that identical menu-only path unattended — it starts
its own node, completes a full local deployment, and asserts the completion screen. The form discovers unlocked accounts, assigns clearly separated deployer/admin/bot
roles, deploys fake collateral and a mock Muon verifier, and stores no signer secret. A full
local run also completes the ownership, Core registration, and SymbolManager handover with
the unlocked local admin before rerunning strict health. That convenience is hard-disabled
for forks and live networks.

The form selects the deployment signer once. Hardhat keystore is first and recommended;
the official keystore prompt temporarily takes over the terminal and receives a secure,
non-echoed byte stream directly. One unlock is reused in memory for later Hardhat
subprocesses in that task run, then zeroed when the run returns to the menu. The progress UI
resumes after the keystore unlocks.
RPC/explorer credential storage is a separate Yes-defaulted question, so choosing a
private-key wallet or Ledger does not force operators to handle infrastructure credentials
differently. Secret values never enter a recipe, task input, event, or log. Environment
references are accepted only for local and fork operation.

Live deployment includes preflight, compilation, a matching fresh fork rehearsal,
rehearsal review, typed live-network confirmation, execution, explorer verification,
canonical health checks, and handover proof. A Safe or governance action places the task in
`waiting_external`; continue the same task after it confirms.

## Transaction signers

Every mutating task declares a transaction-signing role. The task asks once per role—not
once per transaction—then binds the public selection into its input hash:

| Choice                             | Durable state                         | Execution                                                                  |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Hardhat keystore wallet with key X | mode and key name                     | official encrypted Hardhat keystore signer                                 |
| Private-key wallet                 | mode and derived address              | key is masked, memory-only, and requested again after process restart      |
| Safe multisig — export JSON        | Safe address and batch digest         | writes Safe Transaction Builder JSON with ABI-decoded method names         |
| Safe multisig — create proposal    | Safe address, owner identity, tx hash | owner signs and proposes through the official Safe SDK/Transaction Service |
| Ledger account with address Z      | address and derivation family         | Hardhat Ledger signer; the device confirms each broadcast                  |
| Unlocked local-node account        | mode and bound authority when known   | exact unlocked authority on the persistent localhost rehearsal             |

Raw contract creation cannot be represented as a normal Safe call. Deployment roles
therefore allow keystore, transient private-key, Ledger, or local-node signers. A live
deployment separately asks how its governance handover should be delivered: Safe Builder
JSON, a direct Safe proposal, or manually recorded actions. ExpressProvider patches can be
entirely Safe-backed: the patch process computes exact calldata without broadcasting an EOA
transaction, writes/proposes the batch, then waits for execution and re-proves the chain
state on continuation.

Safe Builder artifacts are written under `tasks/data/<chainId>/safe/`; fork-only exports
are isolated under `tasks/data/<chainId>-fork/safe/`. Each batch is atomically written and
bound to chain ID, Safe address, target, value, calldata, descriptions, and task run. Direct
Safe service submission is refused for local and fork networks. API keys and Safe-owner
credentials remain transient and are redacted from raw logs.

During execution one live progress panel shows phase, completed steps, current action,
working/waiting status, latest redacted activity, confirmed/pending/failed transactions,
elapsed time, and warnings. A heartbeat keeps elapsed time and status moving even while a
compiler, RPC, or receipt wait is quiet. Press `d` to show or hide transaction hashes, gas,
receipts, explorer evidence, and recent redacted raw output.
The first Ctrl+C requests a pause at the next safe boundary. A second Ctrl+C exits
immediately after atomically preserving resumable state.

## Durable state and evidence

Transient runner state is local and ignored by Git:

| Path                                            | Purpose                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| `.symmio/tasks/active.json`                     | The single active mutating task                           |
| `.symmio/tasks/runner.lock`                     | Cross-terminal process lock                               |
| `.symmio/tasks/runs/<task>-<run>/events.ndjson` | Structured event journal                                  |
| `.symmio/tasks/runs/<task>-<run>/raw.log`       | Redacted stdout/stderr                                    |
| `.symmio/tasks/history/`                        | Indefinite completed, cancelled, and failed local history |

Canonical sanitized deployment reports, receipts, component evidence, checklists, and
checkpoint archives remain under `tasks/data/`.

The active record binds task version, source hash, typed input hash, recipe and dependency
digest, chain, observed signer, and stable plan. Resume refuses changed intent or source.
Ordinary failures pause a mutating task. Cancellation never sends compensating
transactions: it stops new work, reconciles every submitted hash, records confirmed
irreversible effects and recovery guidance, then archives the task. Unknown outcomes keep
the task in `cancel_pending`.

### Clearing `cancel_pending`

A task stays in `cancel_pending` while any submitted hash has an unknown outcome, and an
active task blocks every other mutating action. The panel names the blocking hashes. In
order:

1. Choose **Cancel active task** again. Each attempt re-runs reconciliation, which is all
   that is needed once the RPC can see the transaction or its replacement.
2. If the transaction was repriced, restart `./symmio` with
   `DEPLOY_TX_REPLACEMENTS=originalHash=replacementHash` (comma-separate multiple pairs) so
   reconciliation can bind the original hash to the transaction that actually landed.
3. Only after proving a hash is absent from the chain _and_ its nonce is reusable, restart
   with `CONFIRM_DROPPED_TX_HASHES=hash`. This asserts operator knowledge that the
   transaction can never land; reconciliation still re-checks the nonce before accepting it.

The same variables unblock a paused deployment whose resume is refused for unresolved
broadcasts. They are read at reconciliation time, so they must be present in the environment
that launches `./symmio`.

## Task definition standard

The complete authoring contract and required test matrix live in
[`cli/TASK_AUTHORING.md`](TASK_AUTHORING.md). New or materially changed operator tasks must
satisfy that standard before they are presented as ready.

The UI and tests call only the seam exported by `cli/task-runner.js`:

```text
catalog()
start(id)
resumeActive()
cancelActive()
getActive()
```

Every entry in `cli/tasks/registry.js` declares:

- a stable ID and integer version;
- menu category, title, description, and risk level;
- supported networks and typed input declarations;
- a plan with stable phase, step, and batch-item IDs;
- resume and cancellation policies;
- output artifacts and one handler;
- reconciliation plus shared transaction-journal support for every mutating task.

The registry wrapper adds the standard signer input to transaction tasks. A task that
creates contracts uses the EOA-capable policy; a call-only task may opt into Safe file and
Safe service delivery. Handlers receive populated transaction requests through their
adapter, and EOA/Ledger broadcasts still go through the shared write-ahead transaction
helper. A Safe outcome is an exported/proposed intent—not a confirmed transaction—and must
remain `waiting_external` until the chain proves execution.

Registration is explicit. To add a one-time maintenance operation:

1. Define one task in `cli/tasks/registry.js` (or import its definition there).
2. Add that definition to `TASK_DEFINITIONS`.
3. Apply the test matrix in `cli/TASK_AUTHORING.md`, including the relevant real signer,
   subprocess, resume, UI, and post-state boundaries.

No menu code changes are needed. A small task has one phase and one step. A large workflow
uses stable item IDs and sends every write through `tasks/deploy/tx.ts`, which records the
transaction before waiting for its receipt.

Low-level Hardhat tasks are internal adapters. They may be used by registered task handlers,
but are not supported operator entrypoints and must not be documented as public commands.

### Repair settleUpnl InstantLayer templates

From `./symmio`, select **Other maintenance scripts** and then
**Recreate settleUpnl InstantLayer templates**. The operation reads all four settlement
template variants from their original IDs, verifies that `quoteId` is injected at byte offset
448 (and that byte offset 480 remains `currentPrice`), creates byte-for-byte replacements while
preserving instant-open mode, and only then deactivates the originals. It is idempotent and
verifies the registry again after execution. Live Arbitrum defaults to a
Safe Builder file; EOA, Ledger, and direct Safe proposal modes remain available according to
the task's signer policy.

The registered CLI task uses the following guarded script internally. Its default is a
read-only plan; broadcasting requires both execution variables:

```bash
INSTANT_LAYER_ADDRESS=0x... \
  npx hardhat run --no-compile scripts/recreateInstantLayerSettlementTemplates.ts --network arbitrum

INSTANT_LAYER_ADDRESS=0x... EXECUTE=true CONFIRM_CHAIN_ID=42161 \
  npx hardhat run --no-compile scripts/recreateInstantLayerSettlementTemplates.ts --network arbitrum
```

Set `REPAIR_PLAN_OUTPUT=/path/to/plan.json` in plan mode to write the exact ordered,
Safe-compatible calldata without broadcasting. For live operation, prefer the registered
CLI flow because it adds durable authorization, signer selection, Safe delivery, resume, and
post-state evidence around this script.

## Catalog boundary

The initial catalog contains full/Core/PartyB/SymbolManager/ExpressProvider/Liquidator
deployment, local/fork-only FeeDistributor/MultiAccount/Multicall deployment,
ExpressProvider reconciliation, the full deployment checklist, and the reviewed
maintenance operations. CREATE2 factory, fake stablecoin, individual diamonds,
InstantLayer, AccountLayer, and verifier primitives remain hidden dependencies.

Fuzzing, test runners, package hooks, build helpers, local initialization, and shell wrappers
are development tooling, not maintenance menu entries.
