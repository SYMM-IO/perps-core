# Deploying SYMMIO

This is the operator runbook for the menu-only SYMMIO application. It describes the safety
contract; the receipts, reports, checklist, and handover evidence produced by a particular
run are the proof for that deployment.

## Start

Use Node from `.node-version`, install the locked dependency tree, and run the operations
checks before a deployment checkout is handed to an operator:

```bash
node --version
npm ci
npm run check:operations
```

Then launch the interactive application:

```bash
./symmio
```

It requires a TTY. Public subcommands and non-interactive compatibility modes do not exist.
Hardhat tasks and scripts are internal adapters behind registered menu tasks.

### Persistent local rehearsal

Keep the chain alive across the complete workflow instead of using an ephemeral in-process
network:

```bash
npx hardhat node --hostname 127.0.0.1 --port 8545
```

In a second terminal launch `./symmio`, choose **Deploy a contract**, then **Persistent local
Hardhat node**. The form discovers the node's unlocked accounts and shows exactly which one
will act as deployer, governance admin, PartyB signer and operator, SymbolManager operator, Express
operator/signer, and affiliate. No private key, RPC URL, or password is written to the
recipe or task state.

The full local workflow uses the unlocked governance account to accept Core, AccountLayer,
and ExpressProvider ownership, register ExpressProvider, and grant SymbolManager operator
roles. Every action is journaled before receipt waiting and the deployment then reruns its
strict health gate. This automation refuses any mode or chain other than local/31337; fork
and live handovers remain explicit Safe/governance waiting states.

## Fresh deployment

Choose **Deploy a contract**, then select the full system, Core bundle, or supported
standalone component. The UI:

1. loads reviewed network defaults;
2. collects and validates required public values;
3. selects a deployment signer once, with Hardhat keystore recommended first;
4. writes and digest-binds the recipe;
5. runs read-only preflight and compilation;
6. starts a fresh matching fork rehearsal and reviews it;
7. requires the exact live network name;
8. executes through write-ahead transaction journaling;
9. completes explorer verification and canonical health checks;
10. proves handover and deployer privilege removal.

Local/test reports and checkpoints are not imported into a live task. If an incomplete
legacy checkpoint exactly matches chain and recipe digest, the UI offers an explicit import
with No selected. Completed reports are always history.

Every live recipe requires a production multisig admin distinct from the deployer, explicit
fee and liquidation recipients, a reviewed collateral contract, real Muon configuration,
complete permissions, reviewed protocol values/templates, and explorer verification.
Mock verifiers and unsafe known keys are blocked on known mainnets.

The signer is task-bound rather than embedded in the recipe. Operators may choose a named
Hardhat keystore wallet, a masked memory-only private-key wallet, or a Ledger address for
deployment transactions; localhost also allows its unlocked node account. Raw contract
creation is not a Safe call, so a Safe is used for call-only patches and governance
handover, not as the deployment signer. Private keys and Ledger identifiers do not become
`env://` recipe references. Live RPC and explorer references must use the Hardhat keystore.

## Components and patching

Core is a bundle: Core Diamond, facets/libraries, AccountLayer, Muon verifier, and
InstantLayer. PartyB, SymbolManager, and ExpressProvider may be deployed separately against
a report-bound existing Core. FeeDistributor, MultiAccount, and Multicall remain local/fork
only until their live workflows meet this runbook's full safety contract. Primitive
diamonds, verifier pieces, fake stablecoin, and CREATE2 factory are hidden dependencies.

A PartyB deployment requires `partyB.operators` as a non-empty address list. The deployment
grants each listed account `TRUSTED_ROLE` and verifies the grants on-chain. The PartyB
`signer` is optional. When omitted, deployment leaves `signer()` at `address(0)`, so ERC-1271
signature validation remains disabled until an account with `SETTER_ROLE` configures it.
Governance keeps `MANAGER_ROLE`, which can withdraw tokens and change destination permissions.

Choose **Patch configurations for deployed contracts** for an existing ExpressProvider.
Select only the sections that should be authoritative, then choose the patch signer.
Declared role sets grant missing
holders and revoke holders removed since the last applied component report. Omitted sections
are untouched. Mutations outside the signer authority are recorded as exact Safe actions and
move the task to `waiting_external`. Choosing Safe JSON or direct Safe proposal makes the
whole patch action-only: the adapter computes and validates every call without broadcasting
from an EOA.

Express credit caps deserve explicit review: zero means unlimited. Removed affiliates are
not automatically zeroed because that would remove their limits. Post-payout loss settlement
uses the accepted ledger/bad-debt model documented in the project architecture; cancellation
does not attempt compensation.

## Progress, pause, resume, and cancellation

The main progress surface is one live-updating panel showing phase, completed/total stable
steps, current action, working/waiting status, latest redacted activity, transaction counts,
elapsed time, and warnings. Its heartbeat remains visible during quiet compilation, RPC, and
receipt waits. Press `d` for hashes, replacement hashes, receipt/gas evidence, explorer
context, and recent redacted logs. When Hardhat requests a keystore password, the panel
temporarily yields the terminal to a secure non-echoed relay and resumes after unlock; the
password is never added to task state, events, or raw logs.

The first Ctrl+C requests a cooperative pause. The current safe boundary completes and the
active record remains under `.symmio/tasks/active.json`. A second Ctrl+C exits immediately
after atomically recording a resumable paused state.

Choose **Continue active task** to resume. Resume refuses a changed task version, source,
typed input, recipe/dependency digest, chain, signer journal, or plan. Completed stable steps
are skipped. Receipt timeouts and process interruption do not authorize another broadcast:
the recorded hash is reconciled first, including same-intent replacements and confirmed
reverts.

Choose **Cancel active task** for safe abandonment. Cancellation stops new steps and
reconciles submitted transactions. It never rolls back confirmed effects. If any outcome is
unknown the state remains `cancel_pending`; after outcomes are known, the archived result
lists irreversible work and recovery instructions.

Only one mutating task may be active in a checkout. A process lock prevents another terminal
from running or cancelling it concurrently. Read-only checks do not occupy the active slot.

## Safe and handover waiting states

Fresh deployments use temporary deployer roles to finish configuration before those roles
are revoked. The ordinary fresh handover therefore contains ownership acceptance only;
reused components may still expose exact governance repair calls.

The deployment/component report is the authoritative list of manual actions. The task
classifies the configured admin from chain state before choosing delivery. An EOA can use a
Ledger hardware wallet, a Hardhat keystore wallet, a transient private key, or an unlocked
local account where allowed. A verified Safe can receive Safe Transaction Builder JSON with
decoded method names or a direct proposal through the official Safe SDK. An unknown
contract stays manual. The proposal or transaction receipt alone is not treated as final;
output remains **Handover required** until exact post-state reads pass.
After those actions confirm, choose **Continue active task**. The same stable handler rereads
live state, avoids redeployment, runs the final health gates, marks the lifecycle complete,
and archives the task.

Cancellation while waiting is still abandonment, not rollback. Ownership transfers already
started and roles already changed remain recorded as confirmed effects.

## Full deployment checklist

Choose **Run the checklist on a new deployment** and select its reviewed recipe. The check is
bound to the recipe/report digest and covers receipts, bytecode/selectors, ownership and
roles, deployer privilege removal, protocol configuration, InstantLayer templates, Muon
permissions, component settings, ExpressProvider credit caps, explorer verification,
handover, and current health.

The task writes timestamped JSON and readable Markdown under
`tasks/data/<chainId>/checklists/`. A failed check still writes evidence and never reports a
healthy deployment.

## Maintenance

**Other maintenance scripts** contains only registered operator operations: RPC health,
protocol configuration show/diff/export, facet verification, explorer retry, HyperEVM
big-block control, and local/fork proxy-upgrade rehearsal. Each uses the
same task policies, progress UI, redacted evidence, and cancellation rules.

Generic proxy upgrades cannot execute on a live RPC. Live upgrades require a separate
reviewed target-specific task with storage-layout and implementation identity proof.
HyperEVM big-block preference changes are mutating tasks and acquire the active slot.

## Evidence paths

| Path                                          | Evidence                                    |
| --------------------------------------------- | ------------------------------------------- |
| `deployment-recipes/<name>.json`              | Portable reviewed recipe                    |
| `.symmio/tasks/active.json`                   | One transient active task                   |
| `.symmio/tasks/runs/`                         | Local NDJSON events and redacted raw logs   |
| `.symmio/tasks/history/`                      | Indefinite local terminal outcomes          |
| `tasks/data/<chainId>/deployment-report.json` | Canonical live system report                |
| `tasks/data/<chainId>/deployment-summary.md`  | Human-readable important-address handoff    |
| `tasks/data/<chainId>-fork/`                  | Isolated fork rehearsal evidence            |
| `tasks/data/<scope>/components/`              | Standalone component/patch reports          |
| `tasks/data/<chainId>/checklists/`            | Timestamped checklist evidence              |
| `tasks/data/<chainId>/safe/`                  | Safe Builder intents and proposal receipts  |
| `tasks/data/checkpoints/completed/`           | Completed underlying deployment checkpoints |
| `tasks/data/checkpoints/abandoned/`           | Explicitly abandoned underlying checkpoints |

The entire `tasks/data/` tree is ignored local evidence and is not pushed by Git. Back it
up securely if another machine must be able to resume or audit the run.

For the task-definition contract and registration instructions, see
[the operator reference](../cli/README.md).
