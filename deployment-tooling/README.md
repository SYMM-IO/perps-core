# Deployment tooling

This directory contains the checked-in code and schema used to define and validate deployments.
It does not describe a deployed network. Operator-owned recipe instances live under
[`deployment-recipes/`](../deployment-recipes/).

`deployment.symm.io/v1` is the portable, reviewed public intent used by the SYMMIO Operator.
Launch the guided application with `./symmio`, then choose a deployment or patch action. The
operator starts from the reviewed profile, collects typed values, validates immediately,
writes the recipe atomically under `deployment-recipes/`, and shows the complete intent before any
execution.

Recipes explicitly bind network and chain, infrastructure secret references, execution policy, governance,
collateral, Muon configuration and permissions, protocol parameters, ordered InstantLayer
templates, and `deploy`/`reuse`/`skip` intent for Core, PartyB, SymbolManager, and
ExpressProvider.

Secrets are references only. The transaction signer is selected and hash-bound by the task
runner rather than embedded in the recipe. Hardhat keystore is the default; `env://`
references are restricted to local/fork workflows. Inline private keys, RPC URLs,
passwords, and explorer keys are invalid.

A reused Core is pinned through `core.fromReport`. The exact report bytes contribute to the
recipe digest and are rechecked on resume. An ExpressProvider `reuse` recipe with declared
sections is a patch: declared roles are authoritative and include revocations against the
last applied report, omitted sections are untouched, unauthorized mutations become Safe
actions, and removed affiliates are warning-only. `maxDebt: "0"` and `maxDebtBps: 0` mean no
limit on those axes.

The schema is [deployment-recipe.schema.json](./deployment-recipe.schema.json), and the
reviewed starter is [examples/arbitrum.v1.example.json](./examples/arbitrum.v1.example.json).
The starter intentionally contains invalid placeholders so it cannot execute without guided
review.

Low-level deployment tasks are internal adapters owned by the task registry. Operators use
only the menu application; see [the operator reference](../cli/README.md).

## Operations assurance and release checks

The operator image pins the official Node 22.15.0 bookworm image and BuildKit 1.7.1 frontend
by their multi-platform registry digests, and installs the lockfile with `npm ci --ignore-scripts`.
Only the reviewed Hardhat verification patch runs explicitly. All config imports and
schemas are copied before compilation. The image runs as `node` (uid 1000), carries OCI
source/revision/version/date labels, and caches only npm downloads through BuildKit.
The Docker context excludes Git, environment variants, operator journals, local recipes,
reports, signer material and generated state. Supply runtime credentials through protected
mounts/keystore configuration; never pass them as build arguments.
On Linux, pre-create the evidence and compiler-cache directories with owner uid/gid
1000:1000 and mode 0700. Mount CLI evidence at `/app/symmio/.symmio`, deployment recovery
records at `/app/symmio/tasks/data`, and the compiler download cache at
`/home/node/.cache/hardhat-nodejs`. The image-owned project directory remains writable
for local build cache and generated types. A protected evidence mount must be writable
by uid 1000 before an interactive operation starts; retain it after the container exits.
Git-history-dependent release upgrade tasks require a reviewed Git checkout and retain
their fail-closed source checks; stripping Git from the image does not waive those checks.

On a machine with Docker and BuildKit, run the development release adapter:

```bash
node scripts/release-candidate.mjs <full-reviewed-commit-sha> <new-evidence-directory>
```

It archives that exact local commit into an isolated directory, injects synthetic exclusion
canaries, builds without layer cache, and verifies uid, Node/lock identity and exclusions.
Separate containers with networking disabled run `check:release`, `check:operations`,
deterministic bounded `test:fuzz:ci`, and `docs:check`. Operator environment variables are
not inherited. Validated checked-in recipe examples come only from the immutable archive,
with individual digests, through a read-only test-container mount; the operator image
still excludes local recipes. Each group has a one-hour deadline. The default fuzz seed is
`symmio-release-0.8.6`, with 50 root actions. The importable `runCandidate` accepts reviewed
overrides (1–10,000 actions, maximum two hours per group).

The protected result bundle retains every exit/failure log, image/toolchain identity,
lock/compiler-config digests, ABI/build-info/library inputs, fuzz records and an artifact
hash index. Missing Docker, a missing required gate, or a failed image check cannot pass.
Evidence directories are never reused. Temporary containers/images are removed; bundles
remain. Configure the actual CI required-check policy separately.

For offline deployment assurance, prepare reviewed input and owner-provided evidence:

```bash
node --import tsx scripts/assure-deployment.mjs input.json evidence.json new-result.json
```

`input.json` uses `operations.symm.io/assurance-input-v1`, a positive `chainId`, canonical
`reportDigest` (`evidenceDigest(report)`), `sourceHash` (`hashSourceTree(checkout)`), and
`finalized: { number, hash, at }`. Set `finalityPolicy: "owner-provided-finalized"`,
`deadlineMs` (1–60,000), `maxAgeMs` (1–86,400,000), `components` (1–100 stable `id`, `address`,
expected `codeHash`, explicit `requiredChecks`) and `journal` (up to 1,000 exact public
transaction records with nonce/intent/confirmation depth and original/replacement hashes).
Credentials and RPC URLs are unnecessary.

`evidence.json` contains matching `chainId`, `sourceHash`, finalized `blockHash`, UTC
`capturedAt`, canonical deployment `report`, recipe `context`, `doctorCode`, and
`strictResults` from the canonical checker (`check`, `status: pass/fail/warn`).
`components[id]` contains chain/block/address, raw `code`, and strict `results`. `blocks`
maps block numbers to canonical `{ hash }`; `transactions`/`receipts` map original or
replacement hashes to public observed data; `code` maps lower-case addresses to bytecode
at that finalized checkpoint. Missing entries stay unknown. See the
[assurance fixtures](../test/operations/assurance.test.mjs) for the object shape.

The adapter reuses operator checklist and receipt/intent checks. It never loads a signer,
sends, proposes, resumes, cancels or writes active task state. Outputs are created
exclusively with protected permissions. Exit codes are 0 for complete scoped evidence,
1 for failed checks, 2 for incomplete evidence. Complete offline evidence validates the
supplied records; it does not independently establish network finality or approve a
deployment. A future provider adapter needs an approved read-only environment and finality
policy before network access is enabled.

## Optional safe telemetry

`createTaskRunner({ telemetry: collector, telemetryLabels: { chain, provider } })` projects
`operations.symm.io/telemetry-v1` after journal persistence. Chain/provider labels are public
aliases. Operation/phase/outcome/error labels are bounded. Run/attempt/transaction IDs are
protected correlation fields; free-form messages, calldata, credentials and full errors
are omitted. Collector errors cannot change task outcomes. Every execution/resume gets a
linked durable attempt, ended on completion, failure, pause or governance wait. Collectors
deduplicate the persisted `eventId` across restarts, including interruptions between event
append and state persistence. Local dedup retains at most 8,192 IDs.

```bash
node scripts/operations-observe.mjs .symmio/tasks/active.json
```

This reads protected state without changing it and projects unresolved count/oldest age
and governance-wait age. Missing historical timestamps are unknown. Continuing the same
governance wait preserves its original age. Waiting snapshots replace indefinite spans.
Audit transitions are retained, while polling snapshots are separate from alerts. A
collector rollout still needs an owner, thresholds, retention and an event-volume baseline.

## Remaining owner evidence from SYM-1539

The local changes address 002–007 and the repository portions of 013–015. Existing paused
runs bind the older source policy: restore their original checkout or use the existing
reviewed source-migration path. Uncertain broadcasts still forbid migration. Redaction
preserves calldata, constructor arguments, and bound input/plan bytes; those must already
contain public intent only. Operator evidence remains private.

Reports 008–011 need approved release/deployed identity, CI enforcement, exact-source
suite/storage/fuzz records, job/alert/backup/restore/finality proof, and named policy owners.
These records cannot be inferred from repository code. Reports 016/017 concern a
consumer/indexer and Lowcap caller outside this checkout. Supply their repositories,
owners and deployment mapping before integration. Their acceptance fixtures must cover:

- Withdrawal identity `(chain, Core, owner, requestId)`, duplicate/out-of-order/reorg logs,
  historical finalization attribution, canonical finalized state, distinct physical,
  virtual and advanced amounts, and due-age/coverage denominators. Completion comes from
  state; an event alone cannot establish token payout.
- Off-chain operation/oracle/original/replacement transaction links across simultaneous
  operations, success/revert/timeout/reorg/resume, with canonical receipt/log positions.
  Preserve workflow IDs across attempts, signed bytes, Muon/EIP-712 structures and calldata.
  Keep IDs out of metric labels and inspect existing caller spans before integration.

Solidity findings 001/012 are outside this fix branch.
