# Core upgrade from a standard input

For replacement-layer configuration, administrative roles and consumer wiring, see [configuration preservation](configuration-preserving-upgrades.md).

Core snapshots now preserve Muon configuration and verifier administrative membership. After the executed cut is verified, fill the generated `muon-readiness-request.json`; the task checks service registration evidence and simulates fresh positive/negative Muon calls through all declared routes before restoration. See the [Muon restoration gate](configuration-preserving-upgrades.md#muon-restoration-gate) for its input and evidence requirements. Full fork rehearsal remains optional and scanner publication remains last.

Run `./symmio` and select **Other maintenance scripts → Upgrade Core from a standard input file** (`maintenance.core-upgrade`). Select `tasks/config/core-upgrade.arbitrum-vibe-production.input.json` for the supplied Arbitrum production Core. Base uses the same task with a separate input file.

```bash
nvm use 22.15.0
./symmio
```

The existing Arbitrum-specific Core task targets `0x573310dB6d160B26026B8706EBe9831c7dEF1D09` and a different owner. Its saved runs retain their original targets. The standard input targets the supplied production Core `0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A`.

## One operator input

Use the filename **`core-upgrade.<deployment>.input.json`**. Keep it under `tasks/config/` for menu discovery, or choose another path in the menu. The schema is [core-upgrade-input.schema.json](../deployment-tooling/core-upgrade-input.schema.json); unknown fields and inline secrets are rejected.

| Field                            | Meaning                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                        | Configured live network, chain ID and matching fork network. Arbitrum uses `arbitrum` / `42161` / `fork-arbitrum`; Base uses `base` / `8453` / `fork-base`.                                                 |
| `release.ref`                    | Intended target Solidity release. The checked-out `contracts` tree must match it.                                                                                                                           |
| `release.baselineRef`            | Reviewed Git reference for the deployed baseline. Arbitrum uses `version_0.8.6.2`, the local tag corresponding to the supplied 0.8.6.2 version.                                                             |
| `credentials`                    | Keystore references for deployment wallet, archive-capable RPC and explorer key.                                                                                                                            |
| `execution`                      | Confirmation depth, transaction timeout, slow-transaction notice and logging. Explorer publication is required.                                                                                             |
| `governance`                     | Actual Core owner and owner type; independently specified AccountLayer owner; Safe-file, Ledger or keystore delivery. Ledger derivation family or governance keystore key must be supplied when applicable. |
| `target`                         | Core, existing layers, collateral, verifier, Symbol Manager, liquidator, receiver, solver and Multicall addresses.                                                                                          |
| `inventory`                      | Additional supplied contract/account addresses and subgraph URLs. Runtime hashes are recorded for addresses; URLs are context for integration checks.                                                       |
| `limits`                         | Maximum complete historical quote and symbol scans. Exceeding a limit stops the task.                                                                                                                       |
| `storage.symbolAdjustment`       | Expected legacy 15-word and upgraded 17-word empty SymbolAdjustment getter results.                                                                                                                         |
| `funding.aggregate.repair`       | Require aggregate-funding reconciliation and repair any mismatches against the checked paused snapshot.                                                                                                     |
| `roleGrants.core`                | Grants on `target.core`, with named recipient references or explicit holder addresses. Only missing grants are included.                                                                                    |
| `selectors.core.allowedRemovals` | Explicit Core selector-removal policy. Unreviewed removals stop planning.                                                                                                                                   |

The task generates internal live/fork credential recipes and a source-bound run input. Operators maintain only the standard input; generated recipes, reports and checkpoints are evidence for that run.

Preparation pins HEAD, target and baseline commits, the target contracts tree, the original input digest and both generated recipes. Continuation refuses changes to these bindings. Keep source and inputs fixed until completion. If you skip Git publication or run a fork rehearsal, commit reviewed tracked edits before starting. If you select Git publication, stage the exact reviewed changes first; the task can commit that staged tree before binding the final upgrade source.

Git baseline provenance is separate from deployed bytecode parity: naming the baseline tag does not prove that every deployed facet was compiled from that commit. Snapshot ABI/storage and deployed runtime checks remain required. Fork rehearsal is a separate optional action.

## Categorized upgrade rules

The supplied production input and Base example use `operations.symm.io/core-upgrade-input-v2`. Each rule names the subject it applies to:

```json
{
	"storage": {
		"symbolAdjustment": {
			"legacyAdjustmentWords": 15,
			"upgradedAdjustmentWords": 17,
			"requireEmptyAdjustments": true
		}
	},
	"funding": {
		"aggregate": {
			"repair": true
		}
	},
	"selectors": {
		"core": {
			"allowedRemovals": ["0x9dcdbdda", "0xff363ccc"]
		}
	},
	"roleGrants": {
		"core": [
			{
				"holderRef": "target.symbolManager",
				"role": "SYMBOL_LISTING_ROLE"
			},
			{
				"holderRef": "governance.owner",
				"role": "GLOBAL_PAUSER_ROLE"
			}
		]
	}
}
```

`storage.symbolAdjustment` applies specifically to `getSymbolAdjustment(symbolId)`: all scanned symbols must return 15 zero ABI words before the cut and 17 zero ABI words afterward. An ABI word is 32 bytes; these counts describe the getter result, not physical storage slots. A completed adjustment with nonzero retained fields also blocks this workflow. The supported transition and empty-state requirement are fixed safety rules, not operator bypass switches.

`funding.aggregate.repair` must be `true` for this release. Funding mismatches are repaired using checked old values and the owner's migration authority; its original role membership is restored. `selectors.core.allowedRemovals` lists the reviewed selectors that the cut may remove. Categorization does not change upgrade scope: this task still upgrades Core and preserves its declared dependencies.

`roleGrants.core` explicitly identifies the contract on which roles are granted: `target.core`. Each `holderRef` identifies the recipient and resolves to an address already declared in the input. `target.symbolManager` receives `SYMBOL_LISTING_ROLE` on Core; this does not grant a role on the Symbol Manager contract. `governance.owner` receives the declared Core pause roles. These are the two supported references. For another operator, use `"holder": "0x..."` with its full address instead of `holderRef`. Each entry must specify exactly one recipient form. Unsupported contract categories, unknown references, zero holders and duplicate resolved holder/role pairs are rejected.

The deployment authorization review displays the rule categories and each Core grant's target, named recipient and resolved address. New inspection reports record the rules under `client.policies` and the grant contract address and resolved recipients under `client.roleGrants.core`. Layout, funding-policy and selector-removal errors identify their category. Unknown subjects, missing categories, mixed v1/v2 policy fields and unsupported input versions are rejected.

Existing `operations.symm.io/core-upgrade-input-v1` files remain accepted with flat `storage`, `repairAggregateFunding`, `allowedRemovedSelectors` and a flat `roleGrants` array. Previously saved v2 files with a flat role array also remain accepted; those grants implicitly target Core. The compatibility readers resolve policies and recipients without rewriting the original input or its digest. The historical Arbitrum-specific profile retains its existing format. Existing run evidence and source bindings are not migrated automatically: keep the original files and source for continuation, and start a new run when changing an input's structure or recipients.

## Optional Git release

The standard live task asks **Upgrade Git tag** after loading the input:

- **Skip Git release** continues with a clean, committed checkout. It performs no Git commit, tag creation or push, and needs no Git remote.
- **Create a new tag** asks for its name. With reviewed changes already staged, it also asks for a conventional commit message. It commits precisely the reviewed index; it never stages files automatically. A clean checkout reuses its current commit.
- Selecting a current tag reuses its exact object, including an existing lightweight or signed tag. It must point to HEAD with no staged edits. If a tag points elsewhere, check out the intended release before starting, or choose a new tag. Existing tags are never moved or overwritten.

Select the configured Git remote, review the staged-file summary and approve the release plan. New tags are annotated, using the repository's tag-signing configuration. Configure Git identity and credentials before starting; remote commands have a bounded timeout and do not request hidden terminal input. The remote must have exactly one push URL. Its URL and credentials are not saved in the release journal or displayed in task output.

The durable steps are **review → commit → tag → publish and verify → bind upgrade**. Only the selected tag is pushed, together with its reachable commits; branch refs and unrelated tags are not pushed. The task verifies the remote tag object and its peeled commit against the local release, then binds Core's source and input digest to that commit before compilation or live deployment. `release.ref` remains the target Solidity reference, and `release.baselineRef` remains the deployed baseline. The separately chosen upgrade tag does not replace either field.

`git-release.json` records the reviewed intent digest, commit, tag object and verified publication. **Continue active task** reconciles an interrupted commit, tag creation or push and checks the remote publication again before resuming Core work. A conflicting remote tag stops the task. Cancellation preserves completed Git effects. To change the tag/remote choice or choose Skip after preparation, cancel and start a new task; saved intent is immutable.

Fork rehearsal does not ask for or publish a Git release. Explorer source/ABI publication remains the final stage after service restoration. The live task's changed plan is version 5; existing version 4 runs require their original task/source to continue.

## Optional rehearsal

Choose **Other maintenance scripts → Rehearse a Core upgrade on fork (optional)** (`maintenance.core-upgrade-rehearse`) and select the same standard input. This creates an independent source/input-bound run, pins an inspection block, and rehearses manifest deployment, governance, preservation checks and pause restoration on that fork. It sends no live transactions. Run it whenever needed before the live upgrade; changed source, input or chain state makes earlier evidence historical rather than evidence for the changed upgrade. The live workflow neither launches a fork nor requires a rehearsal report.

## Prepare credentials and authority

Populate the exact keystore keys named in the input using the shared Hardhat keystore. For the supplied Arbitrum file these are:

```bash
npx hardhat keystore set TEAM_DEPLOYER
npx hardhat keystore set RPC_ARBITRUM
npx hardhat keystore set ETHERSCAN_APIKEY
```

Enter secrets only through the keystore prompts. The deployment wallet pays for new contracts; the governance signer must match the configured Core owner. Neither wallet is substituted for the other. The snapshot independently checks Core ownership, default-admin, legacy pause and unpause permissions. This workflow requires those permissions on the configured owner; other authority arrangements need a separately reviewed workflow.

The Arbitrum file selects Ledger with the `ledger-live` derivation family. The owner address was checked on-chain; the device and derivation family have not been verified. Review these input values before starting. For keystore governance, set `signerMode` to `hardhat-keystore`, supply `signerKey`, and remove `ledgerDerivation`. For a Safe owner, use `kind: safe` and `signerMode: safe-file` and remove EOA credential fields.

## Arbitrum findings

The [read-only preflight evidence](evidence/arbitrum-vibe-core-preflight-20261005.json) records Arbitrum block **511862962**, hash `0xfb0d7189a88146ed941c8010e50c651fef6d0a8bdc60cbc29ff88758e15192ce`, timestamp **2026-10-05 08:00:59 UTC**. New owner-role checks use the separately recorded block 511863730.

- Core and AccountLayer owner: `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`, an EOA with no code at the checked block. The older task's Dev Safe is not authorized for this production deployment.
- All ten Core pause flags were false. Accumulated funding was enabled. `getNextQuoteId()` returned 5290; despite its name it returns the last assigned ID. The complete scan includes IDs 1 through 5290.
- All 241 SymbolAdjustment records returned exactly 15 zero words; no active symbol restatement was observed.
- The current manifest contains **32 facets and 9 libraries**. The installed/desired selector comparison is **464 → 479**: 17 additions, 2 removals and 462 retained selectors. The original `diamondCut` selector is retained.
- Removed selectors are `0x9dcdbdda` (`startRestatement(uint256)`) and `0xff363ccc` (`setPartyBOpenPositionsPaused(address,bool)`). Update consumers for `startRestatement(uint256,uint256)`, separate PartyB pause/unpause methods and the 17-field SymbolAdjustment return tuple.
- The owner lacked the nine new pause roles at the role-check block. The input explicitly restores the owner's corresponding pause scopes. Symbol Manager also lacked `SYMBOL_LISTING_ROLE`; its grant is explicit in the input.

The input includes the complete supplied address roster and subgraph URLs. The possible fee collector is recorded as an account; its business role has not been established. Subgraph reachability and post-upgrade indexing compatibility have not been proven by this preflight.

Full historical funding/balance reconciliation and both production fork rehearsals remain pending. The public RPC rejected older pinned state requests with an archive-access requirement. Configure an RPC that retains historical storage for the entire run. This preflight and the local tests do not establish production readiness or live execution.

## Guided execution

1. Compile the target and enforce its size budget. Capture a block-pinned snapshot of authority, known peripheral wiring, runtime hashes, selectors, all historical quotes, balances, symbols, liquidation/restatement state and aggregate funding. Reject incomplete scans, populated adjustments and active liquidations/restatements.
2. Review the report and type the selected chain ID to authorize contract deployment. Deploy all libraries/facets with recovery checkpoints and verify linked runtime bytecode. Explorer submission happens after restoration.
3. Review the generated `core-abi.json`, client/indexer changes and operator inventory. The supplied grants cover known pause scopes and Symbol Manager listing. Review registrar, metadata, protocol-limit and pledge operators separately and add required grants to the input before starting. This task does not enable pledge tokens.
4. Execute or export the maintenance pause through the configured owner. Verify exact execution receipts, then capture a fresh paused snapshot. Preserve a pause that was already active when the run began.
5. Build one complete `diamondCut`, the missing input role grants and any funding repair calculated from the paused snapshot. Funding repairs carry checked old pair values. If needed, temporarily grant the owner's migration role and restore its original state after the repair.
6. Execute the reviewed governance plan and verify its receipts and post-state. Core stays paused throughout.
7. Confirm application reads, liquidator queries and indexer consumption with the new ABI. Restore the original global pause state only after these checks. Verify the unpause receipt and final configuration/roles/selectors.
8. Publish every replacement facet and library through the configured explorer. The report distinguishes `publication-pending` from `complete`. Explorer failure retains per-contract progress and the verified restoration evidence; continuing retries publication without repeating deployments or governance. Publication does not keep Core paused. The generated combined diamond ABI is available independently of scanner UI support.

### Safe governance

Import the exported Transaction Builder file and execute the upgrade actions together as **one Safe transaction**. Match the saved envelope, Safe nonce and Safe transaction hash. Continue the task with the execution transaction hash. Verification requires the exact calldata, canonical successful receipt and expected Safe `ExecutionSuccess` event. An export or proposal does not count as execution.

### EOA governance

The complete `diamondCut` is one atomic transaction. Role grants and funding repairs are subsequent transactions with consecutive reviewed owner nonces; the entire EOA plan is not atomic. Core remains globally paused until every action is verified. The signer comes from the input and each action is simulated before submission.

Each broadcast is journaled before waiting for its receipt. The workflow verifies owner, target, value, calldata, chain, nonce, canonical block and required confirmations before advancing. It checks the paused state against the effects of the confirmed action prefix, including during recovery. Pending owner transactions or unrelated governance drift stop execution.

## Base preparation

Copy [core-upgrade.base-example.input.json](../deployment-tooling/examples/core-upgrade.base-example.input.json) to `tasks/config/core-upgrade.<base-deployment>.input.json`. Replace every placeholder address and `release.baselineRef`, select the actual owner type/credentials, review storage compatibility and selector removals, and list the required role holders. The example is a template, not a verified Base deployment.

Set up the RPC key named in the Base input, such as `RPC_BASE`. Base reuses the same task, schema, manifest, publication, governance and recovery logic. Each chain has independent reports, checkpoints, snapshots, rehearsal bindings and execution nonces. Arbitrum evidence cannot satisfy Base's checks.

The engine currently supports this release's empty **15 → 17** adjustment transition and accumulated-funding baseline. A different Base layout, active migration or incompatible peripheral ABI must stop for separate review.

## Continuation and verification

Select **Continue active task** after external Safe execution or an interruption. Completed stages are skipped; uncertain broadcasts are reconciled without duplicate sends. Do not edit saved inputs, reports or envelopes. A reverted/cancelled governance action or consumed owner nonce can require a separately reviewed recovery plan; the task does not silently rebuild its signed intent.

Evidence lives under `tasks/data/<chain-id>/core-upgrades/<run-id>/`. Cancellation stops future work; it does not reverse a cut, undo deployed contracts or restore service. Keep Core paused when an upgrade check fails. Any reverse cut or storage/accounting recovery needs explicit review.

At the end of an implementation stage, run `npm run lint:ts`. Refresh compilation/size checks once at the stage boundary when the target Solidity artifacts need rebuilding. Use targeted verification:

```bash
npm run test:upgrade -- preflight --match Core
npm run test:upgrade -- governance --match Core
npm run test:upgrade -- verification --match Core
npm run test:upgrade -- recovery --match Core
npm run test:upgrade -- input --match categories
npm run test:upgrade -- input --match role-grants
npm run test:upgrade -- workflow --match categories
npm run test:upgrade -- input --chain-bound --match core
npm run test:upgrade -- workflow --chain-bound --match core
```

Upgrade tests are separated by stage under `test/upgrade/`; contract tests retain their own runners. Deployment-specific checks and their fixtures live in the Git-ignored `test/upgrade/chain-bound/` directory and remain local. See the [upgrade test layout and targeted commands](../test/upgrade/README.md). The stage runner never compiles; prepare current artifacts once when needed.

Tracked runner tests cover optional rehearsal and final-publication retry without duplicate execution; local mined-transaction tests cover receipt rejection and interrupted broadcast recovery. These are local evidence, not proof of production execution or scanner publication.
