# Operator Task Authoring Standard

This is the required contract for every workflow exposed through `./symmio`. An operator
task is not a thin menu entry around a script: it is a reviewed plan, a durable state
machine, an observable execution, and a post-state proof.

Low-level Hardhat tasks and scripts remain internal adapters. Operators enter through the
registered CLI task so the runner can own secrets, locking, progress, evidence, pause,
resume, cancellation, and transaction reconciliation.

## Start with the chain outcome

Before writing code, record these facts in the task's tests or adjacent implementation
notes:

1. The exact pre-state that makes the operation necessary.
2. The intended post-state and the reads that prove it.
3. Every authority and signer that may be required.
4. Whether the operation is read-only, a local write, or an on-chain transaction.
5. Which effects are irreversible and which failures are safe to retry.
6. How an identical rerun detects completed work without duplicating it.

Do not use CLI progress or a successful subprocess exit as the post-state proof. Query the
authoritative artifact or contract again.

## Definition contract

Register the definition in `cli/tasks/registry.js` and `TASK_DEFINITIONS`. The runner
rejects incomplete definitions and unsafe mutating policies at startup.

Every definition must declare:

- a stable lowercase `id` and a positive integer `version`;
- `category`, `risk`, operator-facing `title`, and `description`;
- supported networks and typed inputs;
- `prepare`, `plan`, and `run`, with `handler` pointing to the same `run` function;
- artifact declarations;
- a plan whose phase, step, and batch-item IDs are stable machine IDs;
- for mutations, `reconcile`, the shared transaction journal, stable-step resume with
  source/input drift refusal, and reconciliation-first cancellation.

The registry's `common()` wrapper supplies the standard policies and signer input. Do not
override them with weaker behavior. Increment the task version when a change makes saved
plans or inputs incompatible.

Plans are immutable intent. A handler may execute only declared steps, using the same title
and phase as its plan. Never derive an ID from an array index if the array can be reordered;
use an address, template type, role, or other domain identity.

```js
const TASK = common({
	id: "maintenance.example",
	version: 1,
	category: "maintenance",
	risk: "transaction",
	title: "Apply example repair",
	description: "Plan, execute, and verify the example repair.",
	supportedNetworks: ["arbitrum", "fork-arbitrum"],
	inputs: [{ id: "target", label: "Target", type: "address", required: true }],
	prepare: async ({ ui }) => ({
		/* typed, validated intent */
	}),
	plan: async (_ctx, input) => [
		{ id: "inspect", phase: "prepare", title: "Inspect current state" },
		{ id: "apply", phase: "execution", title: "Apply required changes", items: [input.target.toLowerCase()] },
		{ id: "verify", phase: "verification", title: "Verify final state" },
	],
	run: async (ctx, input) => {
		await ctx.step("inspect", "Inspect current state", async () => {});
		await ctx.step("apply", "Apply required changes", async () => {});
		await ctx.step("verify", "Verify final state", async () => {});
	},
	reconcile: mutationReconcile,
});
```

## Plan, execute, and verify

A transaction workflow must have three distinguishable concerns even if some become no-op
steps after inspection:

- **Plan:** read live state, compute exact actions, show targets/values/calldata effects,
  and require the existing live-network confirmation gates.
- **Execute:** send only the reviewed actions. All EOA, keystore, and Ledger writes go
  through the shared transaction adapter so the transaction is journaled before waiting
  for a receipt.
- **Verify:** read the chain again and compare every intended invariant. A receipt alone
  proves inclusion, not correctness.

The default execution must be non-mutating when the underlying script can be invoked
directly. Live broadcasts require explicit execution and chain-ID confirmation. The CLI may
collect those controls for the operator, but the adapter must still fail closed when run by
itself.

## Idempotency and recovery

Inspection classifies each intended action as already satisfied, required, conflicting, or
unsafe. An identical rerun must skip satisfied work. Partial completion must recompute from
authoritative state and continue from stable item IDs; it must not blindly replay an old
array of transactions.

Before broadcast, validate chain ID, target bytecode, contract identity/version where
available, signer authority, inputs, and any dependency addresses. After an uncertain
broadcast, reconcile the hash and nonce before another attempt. Never hide a confirmed
partial effect behind a generic failure.

Safe export/proposal is not execution. Set `waiting_external` with a concrete instruction,
then verify the on-chain effect when the operator continues. Cancellation stops new work;
it does not invent compensating transactions. Unknown outcomes stay `cancel_pending`.

## Signers and secrets

Use the shared signer selection and environment helpers. A transaction task must work only
with the signer modes allowed by its explicit policy.

- Keystore passwords and private keys go directly to the signer process and never enter
  task input, state, events, or logs.
- Prompt once per task run, reuse that keystore unlock only from mutable process memory for
  later Hardhat subprocesses, and zero it before returning control to the menu.
- RPC/explorer credentials come from the configured recipe/keystore resolution path. Do
  not add a second prompt or environment-only path for a task.
- When a localhost task requires a known role holder, bind that public address in the
  local-node signer selection and make the adapter select that exact unlocked RPC account;
  never silently fall back to account zero.
- Ledger transaction requests must contain explicit gas fields and all fee fields required
  by the signer before the device is asked to approve.
- Persist public signer identity only. Rehydrate transient credentials after restart.
- Safe artifacts must bind chain ID, Safe, target, value, calldata, description, and task
  run.

If an adapter opens an interactive subprocess, use the runner's prompt bridge. Password
input must receive an explicit newline/end lifecycle, the prompt must visibly resolve, and
the progress view must resume afterward.

## Progress and errors

At every moment the operator must be able to answer: what is running, what completed, what
is awaited, and what they should do next.

- Use stable phases and steps for meaningful progress; do not leave a subprocess running
  outside a current declared step.
- Emit structured activity for long compilation, RPC, receipt, and external waits.
- Use `ctx.wait(message)` only when an external action is genuinely required, and make the
  message actionable.
- Capture both stdout and stderr. A non-zero subprocess exit must promote the useful
  underlying error into task state and the paused-task summary.
- Redact secrets and endpoints, while retaining public transaction hashes, receipts, gas,
  and verification evidence.
- Never report “paused” without the cause. Ordinary mutating errors pause for recovery;
  unrecoverable validation/evidence corruption fails explicitly.

## Required tests

Every new or materially changed task must cover the rows that apply. Reuse the runner,
signer, interface, and PTY fixtures instead of mocking away their boundaries.

| Boundary       | Required proof                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| Definition     | Invalid risk, policy, inputs, and unstable IDs fail closed                       |
| Planning       | Exact actions and stable IDs; already-satisfied and conflicting state            |
| Execution      | Dry run sends no transaction; explicit execution sends the reviewed actions      |
| Resume         | A failure after partial success skips confirmed items and safely continues       |
| Idempotency    | A completed operation reruns with zero duplicate writes                          |
| Reconciliation | Submitted, replaced, reverted, timed-out, and unknown hashes remain truthful     |
| Verification   | Incorrect post-state fails even when receipts succeeded                          |
| Errors         | Useful stderr is present in task state and the operator-facing summary           |
| Keystore/PTY   | Password entry resolves, remains secret, and returns to live progress            |
| Ledger         | Requests include explicit gas and fee fields before signing                      |
| Safe           | Export/proposal waits externally and continuation proves execution               |
| UI             | Current step, activity, counts, wait instruction, and failure reason are visible |

At minimum run:

```bash
npm run test:cli
npm run lint
git diff --check
```

Also run the focused Hardhat tests for every adapter or contract behavior changed. Use a
matching fork rehearsal before claiming a live workflow is ready. Do not equate local test
evidence with a live transaction, explorer verification, Safe execution, or final handover.

## Definition of done

A task is ready only when:

- the plan is reviewable before mutation;
- every mutation is journaled and attributable to a bound signer;
- pause, restart, and cancellation preserve truthful resumable evidence;
- the UI shows useful activity and the exact failure/wait reason;
- an identical rerun is safe;
- final state is independently verified;
- applicable CLI, PTY, signer, adapter, and fork tests pass;
- operator documentation names only the registered CLI entrypoint.

Do not commit or broadcast merely because these checks pass. Delivery and live execution
remain separate operator decisions.
