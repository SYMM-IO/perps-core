# Deployment recipes

`deployment.symm.io/v1` is the reviewed, versioned input for SYMMIO deployments. One JSON file owns the network, execution policy, public contract configuration, protocol parameters, and an explicit `deploy`, `reuse`, or `skip` intent for every top-level component.

Create an Arbitrum recipe, replace every `REPLACE_*` value, then preflight before spending gas:

```bash
./symmio recipe init --network arbitrum
./symmio doctor --config deployments/arbitrum.json
./symmio deploy --config deployments/arbitrum.json --plan
./symmio deploy --config deployments/arbitrum.json
```

Create a minimal add-on recipe against an existing Core, replace its placeholders, and run the printed commands:

```bash
./symmio recipe init --network arbitrum --only partyB
./symmio doctor --config deployments/arbitrum-partyB.json --only partyB
./symmio deploy --config deployments/arbitrum-partyB.json --only partyB --plan
./symmio deploy --config deployments/arbitrum-partyB.json --only partyB
```

The generated JSON sets `core.mode` to `reuse`, points `core.fromReport` at the chain-scoped Core deployment report, and selects only the requested add-on. A relative `core.fromReport` path is resolved from the recipe file's directory, not from the shell's current directory. Its exact bytes are included in the deployment-intent digest and rechecked at task startup.

For a full run, v1 requires `core.mode: "deploy"`; each add-on must be `deploy` or `skip`. For `--only partyB`, `--only symbolManager`, or `--only expressProvider`, the selected add-on must be `deploy` and core must be `reuse` with a healthy matching report. Reuse addresses remain representable for inspection and future adapters, but unsupported execution combinations fail during planning.

Standalone component reports live under `tasks/data/<chainId>[-fork]/components/<recipe-name>/`. Rerunning the same command resumes idempotently. `--fresh` starts a new deployment ID and archives the prior report under that directory's `history/` folder before replacement.

Use `status --config <recipe> --only partyB|symbolManager` for a read-only, component-scoped report/checkpoint and on-chain health check. Persistent deploy commands exit `2` while their report is still `pending_handover`; `0` means `complete`.

Valid component names are `core`, `partyB`, `symbolManager`, and `expressProvider`.

`core.muon.upnlValidTime` is the global window every UPNL signature is checked against.
`core.muon.upnlValidTimeByFunction` narrows or widens that window for individual operations,
keyed by MuonFunction name:

```json
"upnlValidTimeByFunction": { "Trading": "30", "LiquidationPartyA": "600" }
```

Each declared entry becomes a `setMuonFunctionUpnlValidTime` call after the global
`setMuonConfig`, and is read back before the run reports success. A function you leave out
uses the global value — on-chain, `0` is the "no override" sentinel, so the recipe rejects `0`
rather than letting it silently mean "clear". Clearing an existing override is a deliberate
governance action, not a recipe edit.

An `expressProvider` set to `deploy` may declare as much or as little of its setup as is ready.
Every section — `registerOnCore`, `creditLine` (`signatureVerifier`, an address or the literal
`"fromCore"` to resolve the core diamond's verifier, plus `muonAppId` and
`muonFreshnessWindow`), `roles`, and `affiliates` — is optional, and an omitted one is simply
not configured: the diamond is cut and handed over, nothing else is written, and a later
`reuse` patch fills in the rest. A section that _is_ declared must still be usable, so an empty
`affiliates` array or an empty `OPERATOR_ROLE` list is rejected rather than treated as a
deferral. The run warns on the way out with the list of sections it left unconfigured.

What makes a provider live is a `SIGNER_ROLE` holder: `SymmioHookFacet` accepts a credit offer
from nobody else, so until one exists the diamond cannot accept, advance, or owe anything.
Declaring a signer is therefore the moment the whole operating surface becomes mandatory —
`registerOnCore: true`, `creditLine`, at least one `OPERATOR_ROLE` holder, and at least one
entry in `affiliates`. Planning fails closed on each, because every one of them fails _open_
if left out: an affiliate with no config is uncapped rather than blocked, a provider with no
operator can accept withdrawals it can never process, and an unregistered one cannot call
`advanceWithdraw` at all.

Per-affiliate `maxDebt` and `maxDebtBps` become the protocol-side caps. `0` on either axis
means **no limit** on that axis; `doctor` warns when both are `0`, since an uncapped credit
line can advance the whole eligible base out of Core.

An `expressProvider` set to `reuse` **with declared sections** is a **patch**: run with
`--only expressProvider`, it reconciles the deployed provider at `address` to match the
declared sections — missing role holders and validators are granted/enabled, and ones present
in the last applied report but dropped from the recipe are revoked/disabled. Omitted sections
are left untouched. Mutations the signer lacks authority for become Safe-ready manual
actions, exactly like the deploy handover; rerun the identical command after they confirm.
Removed affiliates are never auto-cleared (zeroing caps would mean "no limit") — the run
warns and leaves them for an explicit decision.

Secrets never belong in the JSON. Use `hardhat-keystore://KEY` (recommended) or `env://KEY` references. The schema is [deployment-recipe.schema.json](./deployment-recipe.schema.json), and the reviewed starter is [examples/arbitrum.v1.example.json](./examples/arbitrum.v1.example.json). The starter intentionally contains invalid `REPLACE_*` values so it cannot pass `doctor` before review.

```bash
./node_modules/.bin/hardhat keystore set NEW_DEPLOYER
./node_modules/.bin/hardhat keystore set RPC_ARBITRUM
./node_modules/.bin/hardhat keystore set ETHERSCAN_APIKEY
```
