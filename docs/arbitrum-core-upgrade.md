# Current Arbitrum Vibe Core upgrade

Run `./symmio` and choose **Other maintenance scripts → Arbitrum Vibe Core upgrade — current contracts, preserve existing layers** (`maintenance.arbitrum-core-upgrade`). This workflow upgrades the supplied Core using the complete current library/facet manifest. It preserves the existing peripheral contracts and routing.

The older rounding, funding, full-system and Account/Instant upgrade tasks describe different migrations. Their historical targets and saved-run contracts have not been repointed to this release.

## Bound deployment

The checked-in profile is `tasks/config/arbitrum-core-upgrade-42161.json`:

| Component                 | Address                                      |
| ------------------------- | -------------------------------------------- |
| Chain                     | Arbitrum One, 42161                          |
| Core                      | `0x573310dB6d160B26026B8706EBe9831c7dEF1D09` |
| Owner and governance Safe | `0x89bE952790657297ac03f1954b22B668d819D3d9` |
| AccountLayer              | `0x5733107211B2801Acd39933a54d482FE303c4907` |
| InstantLayer              | `0x38aabc7a73523cd47c710fcdeb3b20ae02310180` |
| GaslessLayer proxy        | `0x386EF97D913acf02B3C9452da4Cd4aaEc82eFBca` |
| Symbol Manager            | `0x902a529f5f1E9BCEBe7BC6e785A70aC2Db07Ad2c` |

The deployment signer pays for new contracts. It does not receive Core ownership or operational roles. Governance remains with the Dev Safe; the Main Safe is not substituted for it.

The task uses the existing operator-owned `deployment-recipes/arbitrum-vibe-production.json` for credential references and derives a fork recipe from it. RPC, explorer and wallet secrets use the shared signer/keystore workflow. The recipe's old component addresses do not define this Core-only upgrade; the new profile does. Do not edit a saved task's input, report, recipe, snapshots or Safe files to bypass a check.

## Before starting

- Commit and review the intended source. The task pins HEAD, refuses tracked edits and refuses source/input drift on continuation. A version label alone is not release provenance.
- Use an RPC that can serve the pinned blocks and historical storage throughout the rehearsal and receipt verification. A public RPC may prune state before a long-running task completes.
- Review the new Core ABI and integration changes. `getSymbolAdjustment(uint256)` changes from a 15-field return tuple to 17 fields. `startRestatement(uint256)` is replaced by `startRestatement(uint256,uint256)` with a liquidation nonce. `setPartyBOpenPositionsPaused(address,bool)` is replaced by separate pause/unpause methods and roles.
- Review the new registrar, metadata and protocol-limits roles for your operator inventory. The automatic role migration in this task is specifically `SYMBOL_LISTING_ROLE` for the existing Symbol Manager. It does not grant unrelated permissions to the owner or deployment wallet.
- Coordinate a maintenance window and avoid concurrent governance/configuration changes or competing Safe nonce use between snapshot, review and execution. The task checks fresh state before export, but an exported file is not an on-chain lock against other administrators.

## Guided sequence

1. **Compile and inspect.** Enforce the production size budget. Pin ownership, authority, runtime hashes, selectors, peripheral routing and proxy implementations. Read every historical quote, all listed symbols, active liquidation/restatement state, balances, open-position counts and pair/global aggregate funding. A scan limit is a hard stop, never permission to accept a partial result.
2. **Initial fork rehearsal.** Deploy every current Core library and facet locally, pause through the actual Safe, execute the full Safe upgrade batch, prove the post-state and restore the original global pause flag. This rehearsal cannot be waived.
3. **Authorize, deploy and publish.** After typed Arbitrum authorization, deploy the manifest using shared write-ahead transaction journaling and recovery checkpoints. Reconcile uncertain deployments before retrying. Compare linked runtime bytecode and artifact selectors, then publish each deployment through the configured explorer. Runtime parity and explorer publication are separate checks.
4. **Prepare consumers.** Review the generated `core-abi.json`, client changes and operational roles before pausing service.
5. **Pause through the Safe.** Export a separate maintenance-pause transaction. On continuation, provide its execution transaction hash. The task requires a successful Safe receipt with the exact reviewed payload and Safe transaction hash, then captures a fresh paused snapshot. If the protocol was already paused when this run began, it preserves that state.
6. **Prepare the atomic upgrade.** Build one `diamondCut` covering the complete Core manifest, retaining the existing `diamondCut` selector. Add the Symbol Manager listing grant if needed. Recompute funding repairs from the paused state and include checked old pair values. If the Safe lacks `MIGRATION_ROLE`, grant it immediately before the repair and revoke it in the same Safe batch.
7. **Rehearse the deployed payload.** Fork the paused snapshot with the actual deployed addresses. Execute the exact Safe payload through `execTransaction`, including Safe threshold/approval checks and the MultiSend call. Require the final selector map, linked runtimes, preserved state, repaired funding and restored temporary permissions to match. Local Safe-owner impersonation is confined to the EDR fork; no live owner signature is collected.
8. **Execute and verify the cut.** Review the complete action list and Safe hash. Import the generated Transaction Builder file and execute all actions together as **one Safe transaction**. Match the envelope in `report.json`, including nonce, target, operation, calldata and gas/refund fields; do not split the batch or rebuild it with different fields. Continue with the execution transaction hash. A successful outer receipt alone is insufficient: the task also requires `ExecutionSuccess` for the expected Safe hash and independently checks the post-state while Core remains paused.
9. **Verify service readiness.** Check frontend/backend contract reads, liquidator queries and indexer consumption of the executed cut using the new ABI. Confirm these checks in the task before restoring service. Indexer HTTP health alone does not demonstrate event/ABI compatibility.
10. **Restore the original pause state.** Export unpause separately, only after cut and service verification. Continue with its successful execution hash. Verify current ownership, routing, roles, selectors, runtimes and pause flags. Economic preservation is proved at the paused cut block; legitimate trading after unpause must not be mistaken for upgrade corruption.

## Storage and funding gates

This is a deployment-specific migration, not a generic guarantee that arbitrary historical layouts are compatible. The release inserts fields in `SymbolAdjustment`. Every old record must return exactly 15 zero words at the paused snapshot; after the cut, exactly 17 zero words are required. Any populated record, unexpected ABI, active restatement or active PartyA/PartyB liquidation stops this workflow and requires a separately reviewed migration.

The funding scan reconciles full historical quote discovery with the live open-position list and counter for each discovered trading pair. It calculates signed quote contributions using Solidity-compatible checked arithmetic and truncation. Pair repairs are allowed only when global totals equal the observed pair totals. An unexplained global discrepancy stops the task. The previously observed one-unit residue is discovered and recalculated; its old amount and account are not hard-coded into the repair.

## Recovery and evidence

Continue the same active task after a Safe execution or process interruption. Completed stages are skipped. Submitted deployments use the shared transaction journal and checkpoint recovery; changes to saved evidence, linked bytecode, selectors or the Safe payload fail closed. Cancellation stops new work and does not undo contracts, cancel an exported Safe transaction or automatically unpause Core.

If a check fails after the cut, retain the maintenance pause and investigate the recorded mismatch. An automatic reverse cut is not a safe general rollback once storage or accounting has changed. Review any recovery batch separately.

Per-run evidence is stored under `tasks/data/42161/core-upgrades/<run-id>/`: source/configuration input, snapshots, deployment records, ABI, publication evidence, both rehearsals, exact Safe envelopes and verified receipts. Shared Safe exports are linked by the operator task. These files are local operator data and are not committed. The preflight audit and a local rehearsal do not prove a live deployment, explorer publication, Safe execution or production canary.

## Developer validation

Run the focused `CoreUpgrade.test.ts` and `AccountInstantUpgrade.test.ts` suites, CLI tests, script tests, lint and the compile/size gate. Use the registered task's two fork phases against the selected deployment before claiming a particular live upgrade is ready. Keep fork transactions outside the live journal. The internal Hardhat adapter defaults to nonexecution and refuses a live deployment without both the task binding and explicit chain authorization.
