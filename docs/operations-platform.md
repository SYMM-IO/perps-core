# JSON operations platform

Launch `./symmio`, choose **Other maintenance scripts**, then **Plan a Core upgrade from JSON** (`operations.plan`). Supply an operation request file. The runner validates its deployment profile and release manifest, inspects a deployment at one block, and produces a selector review and standard outputs. It needs RPC access but does not request a transaction signer.

This is the first platform delivery: **Core upgrade planning only**. It does not deploy contracts, simulate a migration, export executable Safe calldata, sign, or send transactions. Existing deployment and upgrade entries retain their own behavior and recovery rules. A generic execution engine and version-specific migration adapters are subsequent work.

The shared lifecycle helpers in `deployment-tooling/operations/upgrade-lifecycle.js` define inspection, deployment, service preparation, checkpoint, application, verification, restoration and final publication. Rehearsal is independent and optional. The existing standard Core execution adapter now follows that ordering and uses resumable per-item publication. See [Core execution and optional rehearsal](core-upgrade.md). The v1 JSON planner remains planning-only; these helpers do not authorize execution of arbitrary migration IDs.

## Inputs

The runtime uses the [version 1 JSON Schema](../deployment-tooling/operations/schemas/v1.schema.json) through Ajv. Definitions in `$defs` are `request`, `profile`, `release`, `resolved`, `snapshot`, `plan`, `verification`, and `result`. Every document has `schemaVersion: 1` and a distinct `kind`. Unknown fields and unsupported versions are rejected. The schema deliberately accepts only `upgrade`, component `core`, and execution mode `plan` in this delivery.

Three operator-owned files describe an operation. Copy the [examples](../deployment-tooling/operations/examples/request.json) to your own configuration directory and replace their placeholders. Example addresses, fingerprints, source commit and artifact hash are deliberately unusable; they are not deployment defaults.

### Operation request

```json
{
	"schemaVersion": 1,
	"kind": "symmio.operation",
	"deploymentProfile": "profile.json",
	"operation": "upgrade",
	"parameters": {
		"components": ["core"],
		"releaseManifest": "release.json"
	},
	"execution": { "mode": "plan" }
}
```

Profile and release paths resolve relative to this request file. A relative credential recipe belongs to its profile; relative artifact paths belong to their release manifest. Absolute local paths also work. Remote document URLs are rejected. No request can select an arbitrary executable script or bypass validation by setting `mode` to `execute`.

### Deployment profile

The profile contains its ID, network name/chain ID/mode, a credential-recipe reference, Core address, expected upgrade authority and the installed baseline. The baseline contains a reviewed identifier and the complete set of installed facet runtime code hashes, including DiamondCutFacet. Fingerprints are deployment-specific because linked addresses can change bytecode between installations. They therefore belong in the profile, not the reusable release manifest.

Obtain fingerprints from a reviewed inspection of the installed deployment; use `keccak256(runtime bytecode)`, not a source hash or artifact hash. The planner compares the complete observed set, verifies the chain and Core owner, and records the selector-to-facet mapping. A matching code set and baseline ID do not prove storage or economic compatibility.

`credentialRecipe` reuses the existing validated deployment recipe for RPC configuration. Its network must match all three profile fields. Component addresses in that older recipe do not override the operation profile. Secret values remain in the existing keystore/environment resolution path; inline keys and endpoint URLs do not belong in the new documents. Live recipes keep the existing keystore restrictions. This credential bridge is transitional; it avoids introducing another secret store.

### Release manifest

The release identifies the exact 40-character source commit, `production` build profile, supported baseline IDs, the complete desired Core facet artifact list, permitted selector removals and declared migration IDs. Keep the reserved `diamondCut` facet out of that list; the installed selector is retained. `init(bytes)` is excluded from public selectors, consistent with the Core deployment convention.

Each artifact entry has its local JSON path and a `sha256:`-prefixed hash of the exact file bytes. After compiling the reviewed source with the production profile, record the full facet set, including unchanged facets. Do not supply only changed facets: absent installed selectors become removals and require explicit approval in `allowedRemovedSelectors`.

Useful commands for preparing a manifest's values:

```bash
git rev-parse HEAD
sha256sum artifacts/contracts/core/facets/PauseControl/PauseControlFacet.sol/PauseControlFacet.json
```

Prefix the second command's hash with `sha256:`. The first release example shows one artifact solely to illustrate the format. It is not a complete Perps release.

The planner checks that the checkout's HEAD equals `sourceCommit` and that artifact files match their declared hashes. It does **not** reproduce the build, prove those artifacts came from that source/compiler configuration, or prove linked-library runtime parity. These remain explicit required checks in the plan. It also records migration IDs without loading or executing them. An empty migration list is not a compatibility attestation.

## Inspection and review

1. Validate documents, credential recipe, addresses and artifact hashes before opening RPC.
2. Pin the block number and hash. Read Core ownership, the diamond loupe and runtime code at that block; reread its hash to detect a reorganization during inspection.
3. Require the profile's baseline ID to be supported by the release, and its code fingerprints to match the installed facets.
4. Calculate selector additions, replacements and explicitly allowed removals. Reject duplicate selectors, reserved-selector replacement and incomplete/unreviewed removals.
5. Publish a deterministic symbolic plan with `executable: false`. Target artifacts are identified by fully qualified names; future deployment addresses and transaction calldata are not invented.

Existing selectors in the supplied manifest are marked for replacement. This first planner does not optimize away facets whose linked runtime is unchanged. Each plan lists outstanding build, storage, migration, role, deployment, rehearsal, authorization and execution-verification requirements.

## Standard outputs

Outputs live in ignored `tasks/data/<chainId>/operations/<run-id>/`. Fork outputs use `<chainId>-fork`. Files are written atomically with restricted permissions.

| File                  | Meaning                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `request.json`        | Validated operation intent                                                                    |
| `resolved-input.json` | Frozen profile/release plus hashes binding all input files, recipe dependencies and artifacts |
| `snapshot.json`       | Block-pinned owner, Core code hash, installed facets and selectors                            |
| `plan.json`           | Symbolic selector changes, artifacts, required libraries and outstanding checks               |
| `review.md`           | Human-readable target, authority, source, snapshot and selector changes                       |
| `transactions.json`   | Empty for this planning-only operation                                                        |
| `verification.json`   | Explicit `not-run` upgrade verification                                                       |
| `result.json`         | Versioned outcome, input/plan digests, artifact locations, errors and next action             |
| `summary.md`          | Human-readable outcome                                                                        |

The result references the runner's existing `events.ndjson` by absolute path rather than maintaining a second journal. Other artifact paths resolve relative to `result.json`. Paths name expected outputs; early failures can leave later-stage files absent. Back up the referenced journal together with the run directory.

Successful planning produces `result.status: "planned"`; the runner marks the planning task completed. **That does not mean an upgrade completed.** Failures produce `paused`, and cancellation produces `cancelled`; no transaction or verification evidence is fabricated. The result is written last, after the stage's other artifacts. Validation failures before a run is created are shown directly in the CLI and create no result file.

The planning task runs inside the existing single-active-task lock. Use **Continue active task** after a transient error. A completed inspection resumes from its recorded historical snapshot; it is not refreshed to current state. If inspection was interrupted after writing its snapshot but before completing the step, the adapter rechecks that historical block. Request/dependency changes and modified bound evidence are rejected. Start a new run for a fresh snapshot or changed intent. Cancellation retains local evidence and sends no transactions.

Existing saved workflows keep their IDs and definitions. The runner's existing source-drift rules still apply: after installing platform changes, older paused runs may require their original checkout or their existing explicit migration mechanism. This delivery does not silently migrate them.

## Development verification

```bash
npm run test:cli
npm run lint
npx hardhat test mocha -- test/parallel/OperationPlanning.test.ts
SYMMIO_OPERATIONS_E2E=true node cli/test/operation-local-e2e.test.js
git diff --check
```

The focused contract test inspects two separately owned diamonds on an ephemeral Hardhat chain. The opt-in E2E starts its own localhost node, deploys test fixtures, and then runs the real planner/subprocess with no planning transactions. It stops the node and removes only its isolated test evidence afterward. These tests are not production fork or live-upgrade readiness evidence.
