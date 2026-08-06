# Deployment recipes

`deployment.symm.io/v1` is the reviewed, versioned input for SYMMIO deployments. One JSON file owns the network, execution policy, public contract configuration, protocol parameters, and an explicit `deploy`, `reuse`, or `skip` intent for every top-level component.

Create an Arbitrum recipe, replace every `REPLACE_*` value, then preflight before spending gas:

```bash
./utils/yarn-classic.sh cli recipe init --network arbitrum
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum.json
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json
```

Create a minimal add-on recipe against an existing Core, replace its placeholders, and run the printed commands:

```bash
./utils/yarn-classic.sh cli recipe init --network arbitrum --only partyB
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum-partyB.json --only partyB
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum-partyB.json --only partyB --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum-partyB.json --only partyB
```

The generated JSON sets `core.mode` to `reuse`, points `core.fromReport` at the chain-scoped Core deployment report, and selects only the requested add-on. A relative `core.fromReport` path is resolved from the recipe file's directory, not from the shell's current directory. Its exact bytes are included in the deployment-intent digest and rechecked at task startup.

For a full run, v1 requires `core.mode: "deploy"`; each add-on must be `deploy` or `skip`. For `--only partyB` or `--only symbolManager`, the selected add-on must be `deploy` and core must be `reuse` with a healthy matching report. Reuse addresses remain representable for inspection and future adapters, but unsupported execution combinations fail during planning.

Standalone component reports live under `tasks/data/<chainId>[-fork]/components/<recipe-name>/`. Rerunning the same command resumes idempotently. `--fresh` starts a new deployment ID and archives the prior report under that directory's `history/` folder before replacement.

Use `status --config <recipe> --only partyB|symbolManager` for a read-only, component-scoped report/checkpoint and on-chain health check. Persistent deploy commands exit `2` while their report is still `pending_handover`; `0` means `complete`.

Valid component names are `core`, `partyB`, `symbolManager`, and `expressProvider`.
ExpressProvider recipe deployment currently fails closed on every target because
post-payout credit-loss settlement is unresolved and its production roles, Muon and
affiliate policy, Core registration, durable recovery, verification, and post-state proof
are not yet represented safely. Credit accounting is already inside the Express diamond and
Core advance support exists; there is no missing external CreditLineManager. The unresolved
path is how a covered post-payout loss is actually repaid or reclassified while preserving
token/liability conservation.

Secrets never belong in the JSON. Use `hardhat-keystore://KEY` (recommended) or `env://KEY` references. The schema is [deployment-recipe.schema.json](./deployment-recipe.schema.json), and the reviewed starter is [examples/arbitrum.v1.example.json](./examples/arbitrum.v1.example.json). The starter intentionally contains invalid `REPLACE_*` values so it cannot pass `doctor` before review.

```bash
./node_modules/.bin/hardhat keystore set NEW_DEPLOYER
./node_modules/.bin/hardhat keystore set RPC_ARBITRUM
./node_modules/.bin/hardhat keystore set ETHERSCAN_APIKEY
```
