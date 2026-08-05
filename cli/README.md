# `symmio` CLI

Operator CLI for deploying, configuring and inspecting SYMMIO deployments.

```bash
node cli/symmio.js --help
```

To get a bare `symmio` command:

```bash
npm link
```

For the step-by-step deployment procedure, see [docs/deployment.md](../docs/deployment.md).
This document is the command reference.

---

## Why it exists

The [audit](../SCRIPTS_AUDIT.md) behind this CLI found that the expensive failures in this
repo's deploy path were **operator** failures, not code failures:

- `PRIVATE_KEY` — documented, set by operators, read by nothing; the deployer silently fell
  back to a key committed to this repository
- a mock signature verifier, enabled by default in the shipped `.env.example`
- an empty `COLLATERAL_ADDRESS` silently deploying a mintable fake token as collateral
- deployment "success" reported while transactions were still unmined
- an InstantLayer template landing at a different id than the chain it was meant to mirror

Every check in this CLI corresponds to one of those. The goal is to make those failures
loud and cheap, before gas is spent.

---

## Commands

| Command | Purpose |
|---|---|
| [`doctor`](#doctor) | Everything that must be true before you deploy |
| [`deploy`](#deploy) | Guided deployment: preflight → plan → confirm → deploy → verify |
| [`status`](#status) | What is deployed on a chain, and whether it is safe |
| [`config`](#config) | Show, diff, or export protocol parameters and templates |
| [`verify`](#verify) | Verify deployed contracts on the block explorer |

All commands take `--network <name>`. Run `symmio <command> --help` for usage.

Exit codes: `0` success (warnings still exit 0), `1` blocking problems found. Suitable for
CI gating.

---

### `doctor`

```bash
symmio doctor --network arbitrum
```

Read-only. Checks:

- **Environment** — `.env` present; flags `PRIVATE_KEY` / `PRIVATE_KEYS_STR` if set, since
  nothing reads them
- **Deployer** — how it resolves (`NEW_DEPLOYER` → `TEAM_DEPLOYER` → keystore → dummy
  fallback), and whether it is a publicly-known key
- **RPC** — reachable, and its chainId matches the network you named
- **Balance** — non-zero, and enough for ~45 contracts on a mainnet
- **Configuration** — admin set and distinct from the deployer; collateral exists on-chain
  with the expected symbol and decimals; mock verifier and dummy affiliate off; Muon
  configured; explorer key present
- **Protocol config** — `tasks/config/protocol-<chainId>.json` parses and is complete;
  lists the templates it would create and any unverified defaults
- **Deployment state** — whether a checkpoint exists that would make `deploy:system`
  **resume** rather than start fresh
- **Self-consistency** — the CLI's copy of the mainnet chain list still matches
  `tasks/deploy/safety.ts`

On a non-mainnet chain the permissive settings are reported as informational, not failures.

---

### `deploy`

```bash
symmio deploy --network arbitrum
```

| Flag | Effect |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--fresh` | Ignore the existing checkpoint (it is archived, not deleted) |
| `--no-verify` | Skip block-explorer verification |
| `--force` | Proceed even if preflight failed |

Four steps:

1. **Preflight** — runs `doctor`; aborts on failure unless `--force`
2. **Plan** — prints network, deployer, admin, fee receiver, collateral, verifier kind and
   which protocol config will be used
3. **Confirm** — on a mainnet you must type the network name, not just `y`. Non-interactive
   shells refuse rather than assuming yes
4. **Deploy**, then `verify:all` and `check:deployment`

Finishes by printing the manual steps the deployer cannot perform (accept ownership on both
diamonds, grant SymbolManager operator roles, add symbols).

If the deploy fails it says so and reminds you it is checkpointed — re-running resumes.

---

### `status`

```bash
symmio status --network arbitrum
symmio status --network hyperevm --diamond 0x... --instant-layer 0x...
```

Addresses are taken from the local deployment report when present; pass `--diamond`,
`--account-layer` or `--instant-layer` to override or to inspect a chain you did not deploy
from this machine.

Probes the chain rather than trusting local records:

- **Facets** — how many are installed and how many selectors; flags an incomplete cut
- **Collateral** — symbol and decimals; flags a `FakeStablecoin`
- **Signature verifier** — flags a mock verifier (it exposes no `SETTER_ROLE`)
- **Role hygiene** — whether the admin holds `DEFAULT_ADMIN_ROLE`, and **whether the
  deployer still does**
- **Ownership** — `owner` and `pendingOwner` of both diamonds. `owner` authorises
  `diamondCut`, so a deployer-owned diamond is an unfinished deployment
- **Templates** — id, name, operation count, active flag

A deployment where the deployer still holds roles or owns a diamond is not finished.

---

### `config`

#### `config show`

```bash
symmio config show --chain 42161
symmio config show --network arbitrum
```

Prints the parameters and templates that would be applied, and warns about any parameter
still sitting at an unverified default.

#### `config diff`

```bash
symmio config diff --network hyperevm \
  --symmio 0x57331038c21982116EE9b0906E4a5c5cB52dcE2e \
  --instant-layer 0x72DBF07457b2712b160F67A85D338F860c1CA620 \
  --against 42161
```

Reads a **live** deployment and compares it against the config another chain would deploy
with. Exits non-zero on any difference.

This is the command that catches silent breakage. InstantLayer template ids are referenced
by hedgers, so a template at the wrong id changes behaviour with nothing reporting an
error. It is how the HyperEVM/Arbitrum mismatch was found: ids 0–2 matched, id 3 did not.

Parameters without an on-chain getter are not compared — see
[mirroring an existing deployment](../docs/deployment.md#mirroring-an-existing-deployment).

#### `config export`

```bash
symmio config export --network hyperevm --symmio 0x... --instant-layer 0x... --to 42161
```

Reads a live deployment into `tasks/config/protocol-<to>.json`. `--to` is the chain the
config is *for*; `--network` is the chain being read *from*.

Recovering the eight getter-less parameters needs an RPC that serves historical logs.
Anything not recovered keeps the built-in default and is listed under
`_provenance.UNVERIFIED_still_defaults`.

---

### `verify`

```bash
symmio verify --network arbitrum
symmio verify --network arbitrum --retry-failed
```

Wraps `hardhat verify:all`. Failures are recorded so `--retry-failed` retries only those.

---

## Recipes

**Before a mainnet deploy**

```bash
symmio doctor --network arbitrum && symmio config show --chain 42161
```

**Rehearse against real chain state, free**

```bash
npx hardhat deploy:system --network fork-arbitrum --fresh true
```

**Check a deployment you did not perform**

```bash
symmio status --network hyperevm --diamond 0x... --instant-layer 0x...
```

**Confirm two chains agree**

```bash
symmio config diff --network hyperevm --symmio 0x... --instant-layer 0x... --against 42161
```

**Gate CI on deployment health**

```bash
symmio doctor --network arbitrum
```

---

## Design notes

**No dependencies, no build step.** Plain ESM JavaScript using only `ethers`, which the repo
already installs. A tool that deploys money should never be runnable from a stale build, and
the operator should always be able to read the exact source that just ran. This also keeps
the supply chain small, in line with the repo dropping unused SDKs.

**Shells out to hardhat.** `deploy` and `verify` print and run real `npx hardhat …` commands
rather than importing hardhat programmatically, so anything the CLI does can be reproduced
by hand.

**One duplicated constant, policed.** The CLI cannot import `tasks/deploy/safety.ts`
(TypeScript, no build step), so the mainnet chain list is duplicated in
`lib/safety-mirror.js`. `checkMirrorDrift()` parses the TypeScript source at runtime and
`doctor` reports any divergence — the duplication cannot rot silently.

**Confirmation proportional to risk.** Mainnet deploys require typing the network name.
Non-interactive shells refuse rather than defaulting to yes.

### Layout

```
cli/
  symmio.js              entry point, arg parsing, help
  lib/ui.js              colours, symbols, tables, prompts
  lib/context.js         .env, chain registry, provider, deployer resolution, records
  lib/hardhat.js         runs hardhat tasks as child processes
  lib/safety-mirror.js   mainnet chain list + drift detection
  commands/{doctor,deploy,status,config}.js
```

To add a command: create `commands/<name>.js` exporting an async function that takes parsed
args and returns an exit code, then register it in the `COMMANDS` map in `symmio.js`.

---

## Not yet built

- `symmio symbols` — add and sync trading symbols (`deploy:system` seeds none)
- `symmio roles` — inspect and hand over roles across every contract
- `symmio upgrade` — wrap the `scripts/upgrade/` tooling
- Recovering the eight protocol parameters that have no on-chain getter, which needs an
  archive RPC to read their `Set*` events
