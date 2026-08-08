# Deploying SYMMIO

Operator runbook for a fresh protocol deployment through the `symmio` CLI.

New to this tooling? Read [deployment-guide.html](./deployment-guide.html) first — it explains
how the recipe, digest, checkpoint and report fit together, and collects the gotchas that
cost the most time. This page is the precise reference you keep open during a run.

This runbook describes the hardened deployment path. It is not evidence that this exact
checkout has been deployed on a fork, a live chain, or a block explorer. Your fork report,
live receipts, health check, and explorer verification are the evidence for your run.

- [Before you start](#before-you-start)
- [1. Configure](#1-configure)
- [2. Preflight](#2-preflight)
- [3. Rehearse on a fork](#3-rehearse-on-a-fork)
- [4. Deploy](#4-deploy)
- [5. Verify](#5-verify)
- [6. Complete the handover](#6-complete-the-handover)
- [Resuming or restarting](#resuming-or-restarting)
- [Slow or congested chains](#slow-or-congested-chains)
- [Operational scripts](#operational-scripts)
- [Mirroring an existing deployment](#mirroring-an-existing-deployment)
- [Reference](#reference)

---

## Before you start

Use the checked-in toolchain. `.node-version` pins Node `22.15.0` and `package-lock.json` is
the dependency lock:

```bash
node --version                                    # v22.15.0
npm ci
npm run check:operations
```

`npm ci` installs exactly the locked tree and fails if `package-lock.json` and `package.json`
disagree — that is the install to use for a deployment checkout. `npm install` is fine for
day-to-day work but may update the lockfile. Do not regenerate the lockfile immediately
before a deployment.

A `preinstall` hook (`scripts/check-package-manager.js`) rejects Yarn and pnpm, which ignore
`package-lock.json` and would resolve a dependency tree nobody reviewed. No npm version is
pinned.

Every operator command in this runbook is `./symmio <command>` — the checkout-local CLI, which
needs no install step and no global binary. If you prefer the bare `symmio`, link it once:

```bash
npm link
command -v symmio
```

If `command -v` prints nothing, keep using `./symmio`; it is the canonical and version-bound
invocation for this checkout.

Six inputs determine whether the deployment is safe. All public intent belongs in one
versioned deployment recipe:

| Input             | Requirement                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Target**        | The recipe names the Hardhat network, expected chain id, and `live`, `fork`, or `local` mode. The command line cannot override it.                         |
| **Secrets**       | The recipe contains only `hardhat-keystore://NAME` or `env://NAME` references. It must never contain a private key, RPC URL, or explorer key.              |
| **Governance**    | The admin must be an explicit production multisig, distinct from the deployer on a known mainnet. Fee and liquidation recipients are explicit JSON fields. |
| **Collateral**    | `core.collateral` explicitly says `deploy` or `reuse`; a live deployment must reuse the reviewed token contract.                                           |
| **Muon verifier** | `core.muon` explicitly says `deploy`, `reuse`, or `mock`. The mock accepts every signature and is blocked on known mainnets.                               |
| **Components**    | `core`, `partyB`, `symbolManager`, and `expressProvider` each say `deploy`, `reuse`, or `skip`. Omitted or ambient component choices are not accepted.     |

The full recipe deploys the Core Diamond, AccountLayer, Muon verifier, InstantLayer, and
the enabled add-ons in dependency order. A component-only run uses the same recipe and
durable evidence, but never silently deploys its dependencies.

Prerequisites: a funded deployer, a private RPC endpoint, the production admin and operator
addresses, reviewed protocol parameters, real Muon inputs, and an Etherscan V2 key if the
run requires explorer verification.

---

## 1. Configure

Create the deployment recipe in the standard project location:

```bash
./symmio recipe init --network arbitrum
```

This creates `deployments/arbitrum.json`, refuses to overwrite an existing recipe, and
prints the exact next commands. The checked-in reference is
`deployment/examples/arbitrum.v1.example.json`; its JSON Schema is
`deployment/deployment-recipe.schema.json`.

The recipe is the only source of public deployment intent. It contains governance and
operator addresses, collateral and verifier choices, all protocol parameters, the ordered
InstantLayer templates, transaction settings, and the mode of every component. There is no
second protocol JSON to keep in sync.

Each component has one explicit mode in the schema:

- `deploy` creates and fully configures it;
- `reuse` declares an existing dependency or target;
- `skip` performs no mutation and removes it from the run's health claim.

A fresh full run currently requires `core.mode: "deploy"`; PartyB and SymbolManager may be
`deploy` or `skip`. Reusing an existing Core is supported for `--only partyB` and
`--only symbolManager` through `core.fromReport`. Unsupported reuse combinations fail in
the read-only plan rather than being guessed by the executor.

A normal full run executes every non-`skip` supported component. A partial run such as
`--only partyB` mutates only PartyB; its reused Core and InstantLayer dependencies are read
and proven, never auto-deployed.

To create the smaller JSON for one add-on instead of trimming the full recipe by hand:

```bash
./symmio recipe init --network arbitrum --only partyB
./symmio recipe init --network arbitrum --only symbolManager
```

These create `deployments/arbitrum-partyB.json` and
`deployments/arbitrum-symbolManager.json`. Each contains only the shared execution/secrets,
the admin, the selected add-on, and a reused Core report reference. Edit the placeholders,
then use the exact `doctor`, `--plan`, and deploy commands printed by `recipe init`.

### Secrets

Keep secret values out of JSON. Put them in the encrypted Hardhat keystore once:

```bash
./node_modules/.bin/hardhat keystore set NEW_DEPLOYER
./node_modules/.bin/hardhat keystore set RPC_ARBITRUM
./node_modules/.bin/hardhat keystore set ETHERSCAN_APIKEY
```

The recipe refers to those names:

```json
{
	"secrets": {
		"deployer": "hardhat-keystore://NEW_DEPLOYER",
		"rpc": "hardhat-keystore://RPC_ARBITRUM",
		"explorer": "hardhat-keystore://ETHERSCAN_APIKEY"
	}
}
```

`env://NAME` is supported for CI secret stores, but `.env` is not the deployment
configuration interface. In recipe mode the CLI and Hardhat do not load `.env`.

The eight Muon permission names are exact and case-sensitive. Empty entries, duplicates,
unknown names, or a partial production profile are rejected. When reusing a verifier,
preflight checks its registered keys, gateway signers, permissions, and repair authority.

The liquidation values are economically active. Excess normal-liquidation profit is
credited to the configured insurance vault, while non-zero soft-liquidation penalties need
a collector. Known-mainnet recipes require both non-zero recipients and a positive reviewed
per-position cap.

---

## 2. Preflight

Run the read-only doctor against the intended live network:

```bash
./symmio doctor --config deployments/arbitrum.json
```

It exits non-zero on blocking problems and checks the signer source, direct RPC chain id,
balance, admin and operator addresses, collateral contract, production switches, Muon
registration and permissions, explorer key, inline protocol config, dependency reports, and
existing checkpoint state. Every remediation names the JSON field to edit.

When a secret uses `hardhat-keystore://`, the dependency-free doctor cannot unlock it and
marks its key/address/API probes as deferred warnings rather than green checks. The Hardhat
task unlocks the declared entries and repeats the signer, chain, authority, and explorer
gates before creating a checkpoint or sending a transaction. Use `env://` only when CI
needs non-interactive secret injection.

Resolve every failure before deploying. Treat warnings about a public RPC, unknown
collateral, unverified parameter provenance, or missing explorer credentials as an explicit
operator decision, not background noise.

---

## 3. Rehearse on a fork

Rehearse the same reviewed configuration through the guided CLI:

```bash
./symmio recipe init --network fork-arbitrum
./symmio deploy --config deployments/fork-arbitrum.json --fresh
```

`fork-arbitrum` is an in-process EVM backed by the configured Arbitrum RPC. It reads real
chain code and token state, but all writes stay local and disappear when the process exits.
Hardhat supplies pre-funded simulation accounts. The upstream chain id remains `42161`, so
the recipe still uses chain id `42161` and evaluates the mainnet safety profile. Compare the
fork recipe with the live recipe and require every public value other than network mode and
verification policy to match. Unsafe production settings are printed loudly; the simulated
network cannot spend live funds.

Pin the fork block in the recipe when reproducibility matters. Fork records are isolated in
`tasks/data/42161-fork/` and never overwrite live deployment evidence.

A fork rehearsal does not prove block-explorer verification, live RPC reliability, real gas
pricing, multisig execution, or final ownership acceptance. Verify those separately.

---

## 4. Deploy

Use the guided command:

```bash
./symmio deploy --config deployments/arbitrum.json
```

It runs doctor, prints the resolved plan, requires risk-proportional confirmation, invokes
the checked-in Hardhat task, and reads the resulting deployment report. On a mainnet,
non-interactive use requires both `--yes` and `--confirm-network arbitrum`.

For persistent targets, exit code `0` means lifecycle `complete`; exit code `2` means the
contracts were deployed and verified but the exact reported admin/Safe handover actions are
still pending. An ephemeral fork rehearsal may exit `0` with `pending_handover`, and prints
that lifecycle explicitly because its simulated state disappears with the process.

Render the complete read-only plan without broadcasting:

```bash
./symmio deploy --config deployments/arbitrum.json --plan
```

For controlled automation, keep the same public CLI boundary so the exact recipe and its
digest are passed to Hardhat together:

```bash
./symmio deploy --config deployments/arbitrum.json \
  --yes --confirm-network arbitrum
```

`SYMMIO_DEPLOYMENT_RECIPE` and `SYMMIO_DEPLOYMENT_RECIPE_DIGEST` are internal CLI-to-task
handoff values, not operator configuration. The task rejects a missing or changed digest,
so do not invoke `deploy:system` by manually assembling those variables.

The core deployment includes:

- collateral selection, Muon verifier, and configuration;
- the Core Diamond plus **32 facets total**: `DiamondCutFacet` and the 31 entries in
  `FacetNames`;
- the AccountLayer diamond and its facets;
- InstantLayer, optional SymmioPartyB, and optional SymbolManager;
- protocol parameters, templates, wiring, role handoff, ownership initiation, and deployer
  privilege revocation.

When `expressProvider.mode` is `deploy`, the run also deploys the ExpressProvider diamond and
its six facets, sets the credit-line Muon config, applies per-affiliate fee and protocol credit
caps and validator sets, grants the declared roles, registers the provider on Core, and starts
the two-step ownership handover. It resumes and verifies on the same checkpoint machinery as
the rest of the run.

Two things about a credit line are worth stating plainly, because they move real collateral:

- `maxDebt: "0"` and `maxDebtBps: 0` mean **no limit** on that axis, not "cannot borrow".
  `doctor` warns when both are zero for an affiliate.
- On a post-payout rollback, `coverLoss` reduces the affiliate's pool balance and books any
  shortfall as `badDebt`. Core is not repaid on-chain — it has no `repayWithdrawAdvance`.
  Recovery is a governance action (`repayCreditBadDebt`, `rescueTokens`). Deploy an
  ExpressProvider only if that settlement model is what you intend.

Transactions log their hash and nonce at submission, emit waiting notices for slow mining,
record replacements and receipts, and include gas/cost evidence in the checkpoint/report.
`execution.logLevel: "verbose"` is the recommended operator mode and the default example.

### Deploy one component

Generate a minimal add-on recipe, edit its placeholders, and narrow the mutation scope
explicitly:

```bash
./symmio recipe init --network arbitrum --only partyB
./symmio doctor --config deployments/arbitrum-partyB.json --only partyB
./symmio deploy --config deployments/arbitrum-partyB.json --only partyB --plan
./symmio deploy --config deployments/arbitrum-partyB.json --only partyB

./symmio recipe init --network arbitrum --only symbolManager
./symmio doctor --config deployments/arbitrum-symbolManager.json --only symbolManager
./symmio deploy --config deployments/arbitrum-symbolManager.json --only symbolManager --plan
./symmio deploy --config deployments/arbitrum-symbolManager.json --only symbolManager

./symmio recipe init --network arbitrum --only expressProvider
./symmio doctor --config deployments/arbitrum-expressProvider.json --only expressProvider
./symmio deploy --config deployments/arbitrum-expressProvider.json --only expressProvider --plan
./symmio deploy --config deployments/arbitrum-expressProvider.json --only expressProvider
```

For an add-on recipe, set `core.mode` to `reuse` and point `core.fromReport` at the completed
or pending-handover Core deployment report. Relative `core.fromReport` paths are resolved
from the recipe file's directory, not from the shell's current directory. The exact Core
report bytes are included in the deployment-intent digest and rechecked before task
execution, so changing the dependency report after review fails closed. `--only` never
deploys Core implicitly. The runner proves the report's chain, deployed code, and required
dependency addresses before the first transaction. Component reports are scoped
independently and cannot claim that the whole protocol was deployed.

Rerun the identical component command to resume and recheck it after any reported Safe
actions are confirmed. Adding `--fresh` creates a new deployment ID; the previous component
report is archived under `tasks/data/<chainId>[-fork]/components/<recipe-name>/history/`
before the current report is replaced. A persistent component run also exits `2` while its
report remains `pending_handover`.

### Change a live ExpressProvider (patch)

The same settings file also changes a provider that is already deployed. Set
`expressProvider.mode` to `"reuse"`, name its `address`, and declare only the sections you
want enforced — for example a new operator set:

```json
{
	"expressProvider": {
		"mode": "reuse",
		"address": "0x<deployed provider>",
		"roles": {
			"OPERATOR_ROLE": ["0x<new bot>"],
			"SIGNER_ROLE": ["0x<signer>"]
		}
	}
}
```

```bash
./symmio deploy --config deployments/arbitrum-expressProvider.json --only expressProvider
```

A declared section is the complete desired state for that section: holders missing on chain
are granted, and holders recorded in the last applied component report but dropped from the
file are revoked. Omitted sections are untouched. Anything the signer cannot execute — role
changes are owner-gated, setters need `SETTER_ROLE`, registration needs core
`PROVIDER_ADMIN_ROLE` — is emitted as Safe-ready calldata and the run exits `2`; rerun the
identical command after the admin executes it. Nothing is deployed and nothing needs explorer
verification. Affiliates removed from the file are deliberately not auto-cleared, because
zeroing their caps would mean "no limit"; the run warns instead.

Read-only component status uses the same recipe and mutation scope:

```bash
./symmio status --config deployments/arbitrum-partyB.json --only partyB
./symmio status --config deployments/arbitrum-symbolManager.json --only symbolManager
```

### Live deployment entry points

Recipe-guided `deploy` / `deploy:system` is the live RPC entry point for the full core
deployment. Recipe-guided `deploy --only partyB|symbolManager` owns a separate durable
component checkpoint and report.
The low-level component tasks (`deploy:diamond`, `deploy:accountLayer`, verifier, collateral,
InstantLayer, PartyB, SymbolManager, MultiAccount, fee distributor, and multicall tasks) are
local/fork building blocks and reject direct live execution. They do not own a durable
standalone transaction journal, so allowing a blind retry after a receipt timeout could
orphan or duplicate a contract.

`deploy:create2factory` is also local/fork only. For live deployment, supply an already
reviewed factory in `core.create2.factoryAddress`, or omit it to use ordinary CREATE. An
explicit factory address with no code is a blocking configuration error; the deployment does
not silently switch address strategies.

The dedicated liquidator workflow is the explicit live exception:

```bash
EXECUTE=true CONFIRM_CHAIN_ID=<chain-id> \
  ./node_modules/.bin/hardhat run scripts/deployLiquidator.ts --network <network>
```

It performs its own plan, chain confirmation, wiring checks, and supports manual recovery via
`LIQUIDATOR_ADDRESS`.

The bare `deployExpressProvider` helper in `tasks/deploy/expressWithdrawLayerDiamond.ts`
remains local/fork only. It installs the cut and hands over ownership, but owns no durable
checkpoint and performs no role, Muon, affiliate-policy, Core-registration, or explorer work.
A live provider goes through the recipe workflow, which does all of that and proves it.

---

## 5. Verify

The guided live deployment requests block-explorer verification inside `deploy:system`, then
runs the canonical health check before publishing a successful lifecycle. A failure leaves
the checkpoint and report in a failed/incomplete state.

Retry recorded explorer failures with:

```bash
./symmio verify --config deployments/arbitrum.json --retry-failed
```

This command is full-system-only. It binds the chain-scoped report, deployment ID, recipe
digest, component modes, and failed-record retry artifact before contacting the explorer.
Standalone PartyB and SymbolManager verification is performed inside their
`deploy --only` workflow; rerun that identical deployment command to retry or finalize it.

Then rerun the same deployment command so the checkpoint completes its required gate:

```bash
./symmio deploy --config deployments/arbitrum.json
```

Inspect the on-chain result through the chain-scoped report:

```bash
./symmio status --config deployments/arbitrum.json
```

For a direct health invocation:

```bash
./node_modules/.bin/hardhat check:deployment --network arbitrum --from-report true
```

Verification is sticky across resumes. Once any run requests verification, a later
`--no-verify` or `--verify false` cannot downgrade that checkpoint; explorer verification
must pass before it can complete.

---

## 6. Complete the handover

The authoritative to-do list is `manualActions` in the chain-scoped full or component
report. The CLI prints that list after deployment. Use
`./symmio status --config <recipe>` for a full run or add
`--only partyB|symbolManager` for a component recipe. Do not substitute a generic checklist
for the report produced by your run.

Common actions are:

1. The configured admin calls `acceptOwnership()` on the Core Diamond.
2. The configured admin calls `acceptOwnership()` on the AccountLayer diamond.
3. If the SymbolManager admin differs from the deployer, the admin grants the exact pending
   operator roles shown in the report. The deployment prints the concrete
   `symbolManager:grantOperatorRoles` command.

After every reported action is complete, rerun the same deployment command. It rechecks the
live state, runs strict health gates, changes the lifecycle to `complete`, and archives the
checkpoint under `tasks/data/checkpoints/completed/`.

Symbol creation is a separate post-deployment operating step; `deploy:system` does not seed
trading symbols.

---

## Resuming or restarting

Re-run the same command without `--fresh` to resume:

```bash
./symmio deploy --config deployments/arbitrum.json
```

The checkpoint is bound to the deployment id, chain/network scope, configuration, protocol
config, deployment sources, and CREATE2 intent. A mismatched resume fails rather than
silently mixing two deployments. Recorded contract addresses must contain code on the
connected chain.

Diamond recovery verifies the exact selector-to-facet ownership map, not only whether a
selector exists. It separates missing additions from replacements and can bootstrap the
Loupe facet before inspecting a partially completed cut.

Use `--fresh` only when abandoning the in-progress attempt. It preserves that checkpoint in
`tasks/data/checkpoints/abandoned/`; it never labels an abandoned run as completed. `--fresh`
is refused while any submitted transaction still has an unknown outcome. Resume normally and
reconcile those hashes first.

Do not hand-edit a checkpoint. Check the last submitted transaction in the explorer before
resuming after a timeout or process interruption.

Confirmed setup setters are not silently replayed on resume. The final health gate rereads
their live values and fails on drift; use its exact governance/remediation hint, then rerun,
rather than clearing a checkpoint bit or letting the deployer overwrite changed policy.

If a prior process stopped without a receipt, resume first reconciles that exact hash. It
will not repeat the checkpoint step while the transaction is pending or unknown. For a
same-intent speed-up/replacement, bind the hashes explicitly:

```bash
DEPLOY_TX_REPLACEMENTS=0x<original>=0x<replacement> \
  ./symmio deploy --config deployments/arbitrum.json
```

The replacement must use the same sender, nonce, target, value, and calldata; a cancellation
is recognized as not having executed the original step. If the RPC no longer knows the
original hash and both latest/pending nonces prove its nonce reusable, the operator may
acknowledge that exact dropped hash with `CONFIRM_DROPPED_TX_HASHES=0x...`. Never use that
escape hatch while the transaction is visible on any RPC or explorer.

Contract creations carry an additional binding to the component path, sender/nonce or CREATE2
salt, init-code hash, expected address, successful receipt, and runtime bytecode. Once a timed-
out creation is proven landed, resume restores that exact address into the checkpoint instead
of broadcasting another deployment.

---

## Slow or congested chains

| Recipe field                  |   Default | Effect                                                                      |
| ----------------------------- | --------: | --------------------------------------------------------------------------- |
| `execution.txTimeoutSeconds`  |     `300` | Seconds before one transaction fails the run.                               |
| `execution.slowNoticeSeconds` |      `30` | Seconds before the first "still waiting" notice.                            |
| `execution.confirmations`     |       `1` | Required confirmations per transaction. Raise where reorg risk warrants it. |
| `execution.logLevel`          | `verbose` | `minimal` or `verbose` live; local/fork tests may use `silent`.             |

A timeout is not permission to start another fresh deployment. Check the transaction hash,
then resume from the checkpoint.

---

## Operational scripts

Scripts capable of changing on-chain state are plan-only by default where their header or
output documents `EXECUTE=true`. Review the complete plan, target chain, addresses,
selectors, calldata, and generated Safe batch before setting it. Standalone mutation scripts
require the literal pair `EXECUTE=true CONFIRM_CHAIN_ID=<connected chain id>`; target-specific
scripts may require an expected current address as an additional stale-plan check.

`EXECUTE=true` is deliberately literal and case-sensitive. Do not add it to a shell profile
or shared shell configuration. `deploy:system` has its own CLI confirmation and checkpoint workflow;
it does not use `EXECUTE=true`.

The generic `upgrade:proxy` task is plan-only on live RPCs and may execute only on local or
simulated fork networks. A generic task cannot prove that an arbitrary implementation has a
reviewed storage layout compatible with the live proxy, so code presence and
`proxiableUUID()` alone are not accepted as production safety. Use a reviewed,
target-specific upgrade script for a live proxy. In simulation, execution still requires
`--execute true --dryrun false` plus `CONFIRM_CHAIN_ID=<connected chain id>`; a confirmed
implementation can be reused with `--implementation 0x...` after an interrupted rehearsal.

Safe Transaction Service submission is a separate external mutation. A checked-in config
cannot authorize it: each run must set `SUBMIT_SAFE_PROPOSAL=true`, the matching
`CONFIRM_CHAIN_ID`, and the exact `CONFIRM_SAFE_ADDRESS`. Batch generation and simulation
remain non-submitting by default.

---

## Mirroring an existing deployment

Export a live deployment into a target chain's config file:

```bash
./symmio config export --network hyperevm \
  --symmio 0x<diamond> \
  --instant-layer 0x<instantLayer> \
  --to <targetChainId>
```

Review `tasks/config/protocol-<targetChainId>.json`, including the ordered templates and
provenance, then copy its validated `parameters` and `instantLayerTemplates` into
`core.protocol` in the target recipe. The export file is an inspection/migration artifact;
the recipe remains the deployment input. Compare the source deployment against the exported
snapshot before copying it:

```bash
./symmio config diff --network hyperevm \
  --symmio 0x<diamond> \
  --instant-layer 0x<instantLayer> \
  --against <targetChainId>
```

The exporter uses exact on-chain reads and direct storage only for parameters without a view
function. It cross-checks storage layout before writing and does not overwrite an existing
config silently.

One important distinction: `setDeallocateCooldown()` writes
`MAStorage.withdrawCooldownPeriod`, while `getMinWithdrawCooldown()` returns
`WithdrawStorage.minWithdrawCooldown`. The exporter reads the former from storage.

---

## Reference

### Recipe fields

| Field                                                 | Requirement                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apiVersion`, `kind`, `name`                          | Exact versioned recipe identity; unknown fields and versions fail closed.                   |
| `network.name`, `network.chainId`, `network.mode`     | Must match the connected Hardhat network and live/fork/local scope.                         |
| `secrets.deployer`, `secrets.rpc`, `secrets.explorer` | Named keystore or CI-secret references; resolved values are never reported or hashed.       |
| `governance.*`                                        | Admin, fee receiver, liquidation recipients, and positive per-position cap.                 |
| `core.collateral`                                     | Explicit deploy/reuse choice and reused address.                                            |
| `core.muon`                                           | Explicit mock/deploy/reuse choice, app id, key, gateways, permissions, and validity times.  |
| `core.protocol`                                       | The complete validated protocol parameters and ordered InstantLayer templates.              |
| `core`, `partyB`, `symbolManager`, `expressProvider`  | Each component has an explicit deploy/reuse/skip mode and its component-specific settings.  |
| `execution.*`                                         | Verification policy, logging, confirmations, timeout, slow notice, and optional fork block. |

The only deployment-related environment variables accepted in recipe mode are the internal
recipe handoff (`SYMMIO_DEPLOYMENT_RECIPE`) and narrowly scoped recovery acknowledgements
such as `DEPLOY_TX_REPLACEMENTS` or `CONFIRM_DROPPED_TX_HASHES`. Operators should invoke the
guided CLI instead of setting the internal handoff themselves.

### Evidence paths

| Path                                                    | Content                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `tasks/data/<chainId>/`                                 | Live deployment records and `deployment-report.json`.  |
| `tasks/data/<chainId>-fork/`                            | Isolated records for a simulated `fork-*` run.         |
| `tasks/data/checkpoints/checkpoint-<chainId>.json`      | In-progress live checkpoint.                           |
| `tasks/data/checkpoints/checkpoint-<chainId>-fork.json` | In-progress fork checkpoint.                           |
| `tasks/data/checkpoints/completed/`                     | Successfully completed and handed-over checkpoints.    |
| `tasks/data/checkpoints/abandoned/`                     | Attempts intentionally replaced with `--fresh`.        |
| `tasks/data/<scope>/components/<recipe>/`               | Component-only reports and durable execution evidence. |
| `deployments/<name>.json`                               | Operator-owned, versioned deployment recipe.           |
| `deployment/deployment-recipe.schema.json`              | Machine-readable recipe contract.                      |

### See also

- [CLI reference](../cli/README.md)
- [Scripts audit](../SCRIPTS_AUDIT.md)
