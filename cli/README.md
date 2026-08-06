# SYMMIO operator CLI

The CLI deploys and inspects SYMMIO from one reviewed JSON recipe. Use the checkout-local
command; it works in Fish, Zsh, Bash, and CI without installing a global binary.

```bash
./utils/yarn-classic.sh cli --help
```

If you want the shorter `symmio` command, run `./utils/yarn-classic.sh link` once. Linking is optional.

## Start here

```bash
./utils/yarn-classic.sh cli recipe init --network arbitrum
# edit deployments/arbitrum.json and replace every REPLACE_WITH_* value
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum.json
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json
./utils/yarn-classic.sh cli status --config deployments/arbitrum.json
```

Configuration and generated state have distinct locations:

| Purpose                 | Location                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Reviewed starting point | `deployment/examples/arbitrum.v1.example.json`                                                |
| Your deployment intent  | `deployments/<name>.json`                                                                     |
| Full deployment report  | `tasks/data/<chainId>/deployment-report.json`                                                 |
| Fork report             | `tasks/data/<chainId>-fork/deployment-report.json`                                            |
| Component report        | `tasks/data/<chainId>[-fork]/components/<recipe-name>/<component>-report.json`                |
| Component history       | `tasks/data/<chainId>[-fork]/components/<recipe-name>/history/`                               |
| Resume checkpoint       | `tasks/data/checkpoints/checkpoint-<chainId>[-fork].json`                                     |
| Component checkpoint    | `tasks/data/checkpoints/checkpoint-<chainId>[-fork]-component-<recipe-name>-<component>.json` |

The recipe contains public deployment configuration. Sensitive signer, RPC, and explorer
credentials are references; the recommended provider is the encrypted Hardhat keystore.
Secret values are never copied into the recipe, plan, checkpoint, digest, or report.

## One recipe, full or partial deployment

The top-level components are `core`, `partyB`, `symbolManager`, and `expressProvider`.
Each has an explicit `mode`:

- `deploy` creates and completely wires that component.
- `reuse` proves and uses the configured existing deployment.
- `skip` excludes the component.

Without `--only`, every component enabled by the recipe is executed in dependency order:

```bash
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json
```

Generate and deploy one component with a smaller recipe:

```bash
./utils/yarn-classic.sh cli recipe init --network arbitrum --only partyB
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum-partyB.json --only partyB
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum-partyB.json --only partyB --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum-partyB.json --only partyB

./utils/yarn-classic.sh cli recipe init --network arbitrum --only symbolManager
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum-symbolManager.json --only symbolManager
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum-symbolManager.json --only symbolManager --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum-symbolManager.json --only symbolManager
```

For a reused Core, `core.fromReport` may be absolute or relative to the recipe file's
directory. Its exact file contents are included in the recipe digest and rechecked at task
startup. Rerun the identical command after any printed Safe actions confirm; it resumes
without redeploying and proves the final state. `--fresh` starts a new deployment ID and
archives the prior component report in the component `history/` directory.

Core is a system bundle. To deploy only the Core bundle, set `partyB`, `symbolManager`, and
`expressProvider` to `mode: "skip"`, then run without `--only`.

`--only` never silently rewrites recipe modes. Required dependencies must be declared as
`reuse` or `deploy`; a skipped dependency is a blocking plan error. ExpressProvider
deployment is currently blocked on every target until post-payout credit-loss settlement is
resolved and its production roles, Muon and affiliate policy, Core registration, durable
recovery, verification, and post-state proof are encoded. Doctor and the planner fail closed
instead of advertising an apparently runnable deployment.

## Commands

### `recipe init`

```bash
./utils/yarn-classic.sh cli recipe init --network arbitrum
./utils/yarn-classic.sh cli recipe init --network arbitrum --only partyB
./utils/yarn-classic.sh cli recipe init --network arbitrum --only symbolManager
./utils/yarn-classic.sh cli recipe init --network fork-arbitrum --out deployments/rehearsal.json
```

Creates `deployments/<network>.json` from a checked-in, reviewed profile. Existing output is
never overwritten unless `--force` is explicit. A network without a reviewed profile is
rejected; the command does not fabricate protocol, Muon, or governance values. `--only`
creates a minimal add-on recipe with `core.mode: "reuse"` and a portable relative
`core.fromReport` path.

### `doctor`

```bash
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum.json
```

Read-only. It validates the recipe and component dependency plan before opening an RPC
connection, then checks:

- network name, chain ID, live/fork mode, RPC reachability, and direct `eth_chainId`;
- signer resolution, unsafe known keys, deployer balance, and admin separation;
- collateral code and token metadata;
- mock-verifier and dummy-affiliate safety policy;
- complete Muon registrations and all eight function authorizations;
- PartyB and SymbolManager configuration when enabled;
- liquidation accounting receivers and cap;
- explorer verification readiness;
- protocol values and InstantLayer templates bound to the recipe;
- checkpoint disposition and internal CLI/task mirror drift.

A configuration failure names the exact JSON field and the exact recipe file to edit.
Keystore references are deliberately reported as deferred warnings: the dependency-free
doctor cannot unlock them, while the Hardhat task must resolve and recheck them before any
checkpoint or transaction.

### `deploy`

```bash
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json
```

The plan prints the recipe digest and a table containing each target, mode, and dependency.
`--plan` stops after doctor and the read-only plan; no transaction is sent.

| Flag                 | Effect                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- |
| `--only <component>` | Execute one component and its declared reused dependencies                         |
| `--yes`              | Skip the interactive prompt; live networks also require `--confirm-network <name>` |
| `--fresh`            | Archive the current checkpoint and begin a fresh run                               |
| `--no-verify`        | Further disable recipe verification on local/fork only; refused live               |
| `--force`            | Continue after preflight failure on local/fork only; refused live                  |
| `--plan`             | Read-only doctor and dependency plan                                               |

The recipe's `execution.verify` value is authoritative. A live recipe must require explorer
verification. Deployments are transaction-journaled, resumable, and accepted only after
the task writes its report and passes its post-deployment health gates.

On a persistent chain, exit `0` means lifecycle `complete`; exit `2` means deployment and
verification succeeded but the printed admin/Safe handover is still pending. Fork runs are
ephemeral and print their lifecycle without using exit `2`.

### `status`

```bash
./utils/yarn-classic.sh cli status --config deployments/arbitrum.json
./utils/yarn-classic.sh cli status --config deployments/arbitrum-partyB.json --only partyB
./utils/yarn-classic.sh cli status --config deployments/arbitrum-symbolManager.json --only symbolManager
```

Reads the exact chain-scoped full or component report and checkpoint, then delegates to the
matching canonical read-only on-chain checker. Critical unreadable probes fail; they are
never reported as a healthy deployment. A component recipe must include its matching
`--only` flag so it cannot inspect an unrelated full-system report.

### `verify`

```bash
./utils/yarn-classic.sh cli verify --config deployments/arbitrum.json
./utils/yarn-classic.sh cli verify --config deployments/arbitrum.json --retry-failed
```

Runs the checked-in `verify:all` task against the network named by the recipe. Verification
is unavailable for ephemeral fork networks. Recipe mode is full-system-only and binds the
deployment report, deployment ID, recipe digest, component modes, and retry artifact.
Component explorer verification is owned by `deploy --only`; rerun that command to retry it.

### `config`

The protocol inspection commands remain available for comparing or exporting an existing
deployment:

```bash
./utils/yarn-classic.sh cli config show --chain 42161
./utils/yarn-classic.sh cli config diff --network hyperevm --symmio 0x... --instant-layer 0x... --against 42161
./utils/yarn-classic.sh cli config export --network hyperevm --symmio 0x... --instant-layer 0x... --to 42161
```

## Compatibility mode

`doctor`, `deploy`, `status`, and `verify` still accept `--network <name>` for existing
automation. `--config` and `--network` are mutually exclusive, and the CLI labels network
mode as compatibility-only. New deployments should use a recipe so intent, component
selection, safety policy, and the resulting report are bound to one digest.

## Implementation boundary

The CLI is plain ESM JavaScript and runs the checked-in local Hardhat binary. It does not
download tools, import a stale build, or duplicate recipe schema validation. The shared
recipe module owns parsing, normalization, validation, dependency planning, and conversion
to the deployment task's compatibility projection. The CLI pins the normalized recipe
digest across the Hardhat process boundary; a reused Core report's exact bytes are also
bound, preventing configuration or dependency-report changes between plan and execution.
