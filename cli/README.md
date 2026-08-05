# `symmio` CLI

An operator CLI for deploying, configuring and inspecting SYMMIO deployments.

```bash
node cli/symmio.js --help
# or, after `npm link` / `yarn link`:
symmio --help
```

## Why it exists

The audit in [SCRIPTS_AUDIT.md](../SCRIPTS_AUDIT.md) found that the expensive failures in
this repo's deploy path were **operator** failures, not code failures:

- a variable (`PRIVATE_KEY`) that the docs told you to set and the config never read
- a mock signature verifier left enabled by the shipped `.env.example`
- an empty `COLLATERAL_ADDRESS` silently deploying a mintable fake token as collateral
- deployment "success" reported while transactions were still unmined
- an InstantLayer template landing at a different id than the chain it was meant to mirror

Every check in this CLI corresponds to one of those. The point is to make those failures
loud and cheap, before gas is spent.

## Commands

| Command | What it does |
|---|---|
| `symmio doctor` | Everything that must be true before you deploy. Exits non-zero if not. |
| `symmio deploy` | Guided deployment: preflight → plan → confirm → deploy → verify → check. |
| `symmio status` | What is deployed on a chain, and whether it is safe. |
| `symmio config` | Show, diff, or export protocol parameters and InstantLayer templates. |
| `symmio verify` | Verify deployed contracts on the block explorer. |

### `doctor`

```bash
symmio doctor --network arbitrum
```

Checks the `.env`, the resolved deployer (including whether it is one of the
publicly-known keys committed to this repo), RPC reachability and chainId agreement,
deployer balance, collateral token identity and decimals, the mock-verifier and
dummy-affiliate switches, Muon configuration, the protocol config file, and whether a
checkpoint exists that would cause `deploy:system` to resume rather than start fresh.

### `config diff` — the one that catches silent breakage

```bash
symmio config diff --network hyperevm \
  --symmio 0x57331038c21982116EE9b0906E4a5c5cB52dcE2e \
  --instant-layer 0x72DBF07457b2712b160F67A85D338F860c1CA620 \
  --against 42161
```

Reads a **live** deployment and compares it against the config a target chain would deploy
with. InstantLayer template ids are referenced by hedgers, so a template at the wrong id
changes behaviour with no error anywhere — this is how that class of mismatch is caught.

### `status`

```bash
symmio status --network arbitrum --diamond 0x... --instant-layer 0x...
```

Probes the chain rather than trusting local records. Notably it reports whether the
**deployer still holds `DEFAULT_ADMIN_ROLE`** — a deployment is not finished until it
does not.

## Design notes

**No dependencies, no build step.** Plain ESM JavaScript using only `ethers`, which the
repo already installs. A tool that deploys money should never be runnable from a stale
build, and the operator should always be able to read the exact source that just ran.
This also keeps the supply chain small, in line with the repo dropping unused SDKs.

**Shells out to hardhat.** `deploy` and `verify` print and run real `npx hardhat …`
commands rather than importing hardhat programmatically, so anything the CLI does can be
reproduced by hand.

**One duplicated constant, policed.** The CLI cannot import `tasks/deploy/safety.ts`
(TypeScript, no build step), so the mainnet chain list is duplicated in
`lib/safety-mirror.js`. `checkMirrorDrift()` parses the TypeScript source at runtime and
`doctor` reports any divergence — the duplication cannot rot silently.

## Not yet built

- `symmio symbols` — add/sync trading symbols (`deploy:system` seeds none)
- `symmio roles` — inspect and hand over roles across all contracts
- `symmio upgrade` — wrap the `scripts/upgrade/` tooling
- Recovering the 8 protocol parameters that have no on-chain getter; they need an archive
  RPC to read from their `Set*` events (see `_provenance` in `tasks/config/protocol-42161.json`)
