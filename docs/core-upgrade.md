# Core upgrade from a standard input

Run `./symmio` and select **Other maintenance scripts → Upgrade Core from a standard input file** (`maintenance.core-upgrade`). Select `tasks/config/core-upgrade.arbitrum-vibe-production.input.json` for the supplied Arbitrum production Core. Base uses the same task with a separate input file.

```bash
nvm use 22.15.0
./symmio
```

The existing Arbitrum-specific Core task targets `0x573310dB6d160B26026B8706EBe9831c7dEF1D09` and a different owner. Its saved runs retain their original targets. The standard input targets the supplied production Core `0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A`.

## One operator input

Use the filename **`core-upgrade.<deployment>.input.json`**. Keep it under `tasks/config/` for menu discovery, or choose another path in the menu. The schema is [core-upgrade-input.schema.json](../deployment-tooling/core-upgrade-input.schema.json); unknown fields and inline secrets are rejected.

| Field                     | Meaning                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                 | Configured live network, chain ID and matching fork network. Arbitrum uses `arbitrum` / `42161` / `fork-arbitrum`; Base uses `base` / `8453` / `fork-base`.                                                 |
| `release.ref`             | Intended target Solidity release. The checked-out `contracts` tree must match it.                                                                                                                           |
| `release.baselineRef`     | Reviewed Git reference for the deployed baseline. Arbitrum uses `version_0.8.6.2`, the local tag corresponding to the supplied 0.8.6.2 version.                                                             |
| `credentials`             | Keystore references for deployment wallet, archive-capable RPC and explorer key.                                                                                                                            |
| `execution`               | Confirmation depth, transaction timeout, slow-transaction notice and logging. Explorer publication is required.                                                                                             |
| `governance`              | Actual Core owner and owner type; independently specified AccountLayer owner; Safe-file, Ledger or keystore delivery. Ledger derivation family or governance keystore key must be supplied when applicable. |
| `target`                  | Core, existing layers, collateral, verifier, Symbol Manager, liquidator, receiver, solver and Multicall addresses.                                                                                          |
| `inventory`               | Additional supplied contract/account addresses and subgraph URLs. Runtime hashes are recorded for addresses; URLs are context for integration checks.                                                       |
| `limits`                  | Maximum complete historical quote and symbol scans. Exceeding a limit stops the task.                                                                                                                       |
| `storage`                 | Supported legacy 15-word and upgraded 17-word empty SymbolAdjustment layouts.                                                                                                                               |
| `roleGrants`              | Explicit reviewed role holders and role names. Only missing grants are included.                                                                                                                            |
| `allowedRemovedSelectors` | Explicit selector-removal policy. Unreviewed removals stop planning.                                                                                                                                        |

The task generates internal live/fork credential recipes and a source-bound run input. Operators maintain only the standard input; generated recipes, reports and checkpoints are evidence for that run.

Preparation pins HEAD, target and baseline commits, the target contracts tree, the original input digest and both generated recipes. Continuation refuses changes to these bindings. Commit reviewed tracked changes before starting, and keep source and inputs fixed until completion.

Git baseline provenance is separate from deployed bytecode parity: naming the baseline tag does not prove that every deployed facet was compiled from that commit. Snapshot ABI/storage checks and both fork rehearsals remain necessary.

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
2. Rehearse the complete manifest deployment and upgrade on the initial fork, using the actual configured governance type. Require preserved state, desired selectors, funding reconciliation, role grants and restoration of the original pause state. Verify the fork's block number and hash. No rehearsal waiver is available.
3. Review the report and type the selected chain ID to authorize contract deployment. Deploy all libraries/facets with recovery checkpoints, verify linked runtime bytecode, and publish every deployment on the configured explorer.
4. Review the generated `core-abi.json`, client/indexer changes and operator inventory. The supplied grants cover known pause scopes and Symbol Manager listing. Review registrar, metadata, protocol-limit and pledge operators separately and add required grants to the input before starting. This task does not enable pledge tokens.
5. Execute or export the maintenance pause through the configured owner. Verify exact execution receipts, then capture a fresh paused snapshot. Preserve a pause that was already active when the run began.
6. Build one complete `diamondCut`, the missing input role grants and any funding repair calculated from the paused snapshot. Funding repairs carry checked old pair values. If needed, temporarily grant the owner's migration role and restore its original state after the repair.
7. Rehearse the exact deployed addresses and governance envelope on the paused fork. Bind that rehearsal to the deployed manifest, paused snapshot and complete action list.
8. Execute the reviewed governance plan and verify its receipts and post-state. Core stays paused throughout.
9. Confirm application reads, liquidator queries and indexer consumption with the new ABI. Restore the original global pause state only after these checks. Verify the unpause receipt and final configuration/roles/selectors.

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
node --test cli/test/core-upgrade-input.test.js cli/test/core-upgrade.test.js cli/test/arbitrum-core-upgrade.test.js
npx hardhat test mocha --no-compile -- test/parallel/CoreUpgrade.test.ts test/parallel/CoreUpgradeGovernance.test.ts
```

Local mocked runner tests cover Arbitrum/Base with Safe/EOA governance; local mined-transaction tests cover receipt rejection and interrupted broadcast recovery. Neither replaces the two deployment-specific fork rehearsals.
