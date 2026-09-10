# Arbitrum AccountLayer and InstantLayer upgrade

Launch `./symmio`, select **Other maintenance scripts**, then **Arbitrum AccountLayer and InstantLayer upgrade — preserve current values**.
Task ID: `maintenance.arbitrum-account-instant-upgrade`.

This task upgrades AccountLayer `0x5733107211B2801Acd39933a54d482FE303c4907`, replaces InstantLayer `0x2C9e944cB71329fC659Da50A10a79a508Dd49ba5`, and upgrades the implementation behind GaslessLayer `0x386EF97D913acf02B3C9452da4Cd4aaEc82eFBca`. Core `0x573310dB6d160B26026B8706EBe9831c7dEF1D09` keeps its installed facets.

## Input and current values

Review `tasks/config/arbitrum-account-instant-upgrade-42161.json` before starting. It fixes target addresses, PartyB administrator addresses, the old Gasless source commit, and the preservation policy. The existing production recipe supplies RPC/explorer credential references; its deployment settings and template defaults do not supply the upgrade's configuration values.

Each run creates `tasks/data/42161/account-instant-upgrades/<run>/` containing:

- `input.json`: target/policy, exact source commit and recipe digests.
- `configuration-input.json`: configuration read from one pinned Arbitrum block, discovery evidence, selector maps and runtime hashes.
- `fork-recipe.json`: the same credential references targeting the local fork.
- `report.json`: deployment addresses, compatibility checks, transactions, rehearsal and verification evidence.
- `party-b-manual.json` and `retire-party-b-manual.json`: missing PartyB calls for external execution by the configured administrator, including sender, target, value and calldata. These files are generated at their respective stages and refreshed from on-chain state on continuation.

The configuration snapshot includes:

| Component    | Preserved values                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| InstantLayer | Core/AccountLayer references; all template IDs, names, operations, insertion points, source indices/offsets, active and instant-open flags; whitelist; registered PartyBs; selected flow participants and administrative roles; cooldown; transient-context setting                                                                                                                                                    |
| GaslessLayer | Existing proxy and storage; deposit fee/minimum; default and per-selector fees, including configured-zero and disabled overrides; daily free-operation quota and exhaustion policy; sponsored-native limit and exhaustion policy; maximum native top-up; top-up fee basis points; treasury; collateral/Core/AccountLayer references; selected admin and relayer memberships; other memberships remain in proxy storage |
| Protocol     | Core selectors; AccountLayer selectors outside the five replacement facets; Core/AccountLayer ownership, pending ownership and pause state; Safe owners/threshold; Gasless fee-charger, fee receiver and account-creator wiring                                                                                                                                                                                        |

Integer values in the snapshot use the contract's raw units. Zero and false are values to preserve. Gasless configuration setters are unnecessary: the implementation upgrade keeps its storage and verifies these values afterward. Only its InstantLayer reference changes.

The task does not migrate InstantLayer user delegations, revocation/replay state or nonces. It does not set `minTimelockDelay`, `scheduleGracePeriod`, or per-account timelocks. Existing raw global timelock slots are compared before and after the cut. Templates are reproduced exactly; any settlement-template repair is a separate operation.

Discovery uses direct getters for the configured flow. It checks the Dev Safe, relayer, Gasless proxy and supplied PartyBs without reading event history or enumerating unrelated holders. `discovery.instantTargets` and `discovery.instantPartyBs` supply mapping keys; Core and AccountLayer are also checked as whitelist targets. `target.relayer` identifies the Gasless `RELAYER_ROLE` recipient. Missing PartyB administrators name `target.partyBAdmins[<address>]` in the error.

`discovery.gaslessSelectors` lists fee-override keys to verify. An empty list means no individual override keys were supplied; it does not claim that overrides do not exist. All overrides remain in Gasless proxy storage, supported by the implementation/layout checks. All scalar fee and gas settings are still read and compared. InstantLayer templates, cooldown and transient mode are read directly. The role scope is `required-flow`; unrelated InstantLayer memberships are outside this migration. An unreadable configured value stops the task rather than substituting defaults.

## Execution order and authorities

1. Compile, inspect current state, compare the old Gasless runtime and linked libraries, and compare old/new storage layouts. Rehearse the complete cut, configuration, wiring and retirement on the exact snapshot fork.
2. Review current values and the required flow permissions, then authorize chain `42161`. Use a separate deployment wallet; it receives no Core, AccountLayer or Gasless administration roles. The replacement InstantLayer constructor gives administration directly to the Dev Safe.
3. Deploy **eight contracts**: `LibQuoteParams`, AccountLayer `CoreFacet`, `MarginFacet`, `ControlFacet`, `ViewFacet`, `TimelockFacet`, the new `InstantLayer`, and a new `GaslessLayer` implementation. Reuse the four Gasless libraries only after verifying their bytecode and links. Publish the eight new contracts on Arbiscan.
4. Export the AccountLayer cut for Dev Safe `0x89bE952790657297ac03f1954b22B668d819D3d9`. Execute it in the Safe, then continue. The cut has no initializer. The task verifies every installed selector before proceeding.
5. Export the replacement InstantLayer configuration for the Dev Safe. The batch copies the selected whitelist, all templates and their exact flags/offsets, cooldown and transient mode; registers the supplied PartyBs; and grants the required Gasless/PartyB operator permissions. The Safe retains administration. Continuation verifies the resulting values and flow roles before wiring Gasless to it.
6. Defer Enigma PartyB wiring to manual execution. With `policy.partyBExecution: "manual"`, the CLI exports the missing `TRUSTED_ROLE` and multicast-whitelist calls on PartyB `0x9be79D4977D86D440F9e1Ea0d468A58104B9b932` to `party-b-manual.json` for administrator `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`. It does not request that wallet or send PartyB transactions. Execute the calls externally when ready, then continue the task. Deployment, the AccountLayer cut and InstantLayer configuration are complete at this point; Gasless cutover waits until direct reads confirm PartyB wiring.
7. Export the protocol wiring batch for the Dev Safe. It grants missing Core/AccountLayer roles to the new InstantLayer, `RELAYER_ROLE` to `target.relayer` on Gasless, and `ACCOUNT_CREATOR_ROLE` to Gasless on AccountLayer. It registers Gasless as a Core operational-fee charger when missing, retaining its receiver. If needed, the Safe grants itself Gasless `CONFIG_ADMIN_ROLE` or Core `FEE_ADMIN_ROLE` using its existing default-admin authority. The final action atomically calls Gasless `upgradeToAndCall(newImplementation, setInstantLayer(newInstantLayer))`. Already-satisfied actions are omitted. Verification checks preserved settings and each required permission.
8. Update the relayer's InstantLayer address and signing domain. Execute a real delegation grant or ordered-nonce operation through the preserved Gasless proxy. Supply its successful transaction hash; the task checks the receipt and an event from the new InstantLayer.
9. Export removal of the old InstantLayer's Core/AccountLayer roles for the Dev Safe. Export `retire-party-b-manual.json` for the PartyB administrator to remove old trust and multicast permission externally. Final verification waits for that manual removal, then checks configuration, selectors, new wiring and retirement.

The selected relayer needs `RELAYER_ROLE` on Gasless. The InstantLayer `OPERATOR_ROLE` recipients are Gasless and the supplied solver PartyBs; the relayer is not granted direct Core/AccountLayer administration or InstantLayer execution authority. The Dev Safe must already have upgrade/default-admin authority on the existing protocol contracts. If it cannot authorize a needed grant, the task names the missing authority instead of exporting an unexecutable self-grant. Enigma PartyB remains administered by the configured EOA; the Dev Safe currently cannot execute that separate stage.

## Pause and recovery

Safe JSON export is a `waiting_external` stage, not proof of execution. Use **Continue active task** after executing each batch. Confirmed contract deployments and completed configuration actions are recovered from their journals and current state. A changed input, source, configuration, implementation or unrelated selector stops continuation. Unknown transaction outcomes are reconciled before another broadcast or cancellation.

Manual PartyB stages also use `waiting_external`. Leaving the calls for later keeps the step pending. Continuing without the required on-chain changes stays at the same step; a partial execution exports only the remaining calls. The manual files contain EOA transaction instructions, not Safe Transaction Builder batches. Their `verified` status means the required state was observed, not that the CLI submitted transactions. The fork rehearsal still simulates those later calls locally to validate the complete upgrade.

For a run stopped during initial discovery with only compilation complete and no journaled transactions, a source/configuration fix requires **Cancel active task**, then starting this maintenance task again. Reopen `./symmio` first to load updated code. The fresh run copies the updated input and pins the new source; do not edit the paused run's hashes to bypass drift checks. The flow-specific discovery no longer uses historical log queries.

The fork rehearsal contains only local transactions. Explorer publication, Safe execution, a production canary and final live verification remain separate evidence. A successful rehearsal does not authorize or prove any of them.
