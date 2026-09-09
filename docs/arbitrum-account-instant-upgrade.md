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

The configuration snapshot includes:

| Component    | Preserved values                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| InstantLayer | Core/AccountLayer references; all template IDs, names, operations, insertion points, source indices/offsets, active and instant-open flags; whitelist; registered PartyBs; role members/admins; cooldown; transient-context setting                                                                                                                                                  |
| GaslessLayer | Existing proxy and storage; deposit fee/minimum; default and per-selector fees, including configured-zero and disabled overrides; daily free-operation quota and exhaustion policy; sponsored-native limit and exhaustion policy; maximum native top-up; top-up fee basis points; treasury; collateral/Core/AccountLayer references; all discovered role members, including relayers |
| Protocol     | Core selectors; AccountLayer selectors outside the five replacement facets; Core/AccountLayer ownership, pending ownership and pause state; Safe owners/threshold; Gasless fee-charger, fee receiver and account-creator wiring                                                                                                                                                      |

Integer values in the snapshot use the contract's raw units. Zero and false are values to preserve. Gasless configuration setters are unnecessary: the implementation upgrade keeps its storage and verifies these values afterward. Only its InstantLayer reference changes.

The task does not migrate InstantLayer user delegations, revocation/replay state or nonces. It does not set `minTimelockDelay`, `scheduleGracePeriod`, or per-account timelocks. Existing raw global timelock slots are compared before and after the cut. Templates are reproduced exactly; any settlement-template repair is a separate operation.

Discovery uses complete configuration-event history plus current getters. Optional `discovery` arrays add known roles, selectors, whitelist targets or PartyBs. Missing PartyB administrators produce an error naming `target.partyBAdmins[<address>]`; provide an authorized administrator in the input JSON. An unreadable value or unavailable event history stops the task before deployment; it never substitutes an empty role list or a default value. Use an RPC with the required history. Do not edit a snapshot to bypass a failed read or drift check.

## Execution order and authorities

1. Compile, inspect current state, compare the old Gasless runtime and linked libraries, and compare old/new storage layouts. Rehearse the complete cut, configuration, wiring and retirement on the exact snapshot fork.
2. Review the current values and authorize chain `42161`. Use a separate deployment wallet, which must not be an existing InstantLayer role holder.
3. Deploy **eight contracts**: `LibQuoteParams`, AccountLayer `CoreFacet`, `MarginFacet`, `ControlFacet`, `ViewFacet`, `TimelockFacet`, the new `InstantLayer`, and a new `GaslessLayer` implementation. Reuse the four Gasless libraries only after verifying their bytecode and links. Publish the eight new contracts on Arbiscan.
4. Export the AccountLayer cut for Dev Safe `0x89bE952790657297ac03f1954b22B668d819D3d9`. Execute it in the Safe, then continue. The cut has no initializer. The task verifies every installed selector before proceeding.
5. The deployment wallet configures the replacement InstantLayer from the snapshot, grants the preserved roles, and renounces its temporary authority. Verification compares the complete resulting administrative configuration.
6. Enigma administrator `0x77A955776Ee1dd3E9C800c3214ed489441d74b94` grants the new layer `TRUSTED_ROLE` and multicast permission on PartyB `0x9be79D4977D86D440F9e1Ea0d468A58104B9b932`. The CLI selects and binds this EOA separately from the deployment wallet. Keystore, private-key and Ledger signing are supported.
7. Export the protocol wiring batch for the Dev Safe. It grants the new InstantLayer's Core/AccountLayer roles and atomically calls Gasless `upgradeToAndCall(newImplementation, setInstantLayer(newInstantLayer))`. The task verifies all preserved settings, new wiring and PartyB permissions.
8. Update the relayer's InstantLayer address and signing domain. Execute a real delegation grant or ordered-nonce operation through the preserved Gasless proxy. Supply its successful transaction hash; the task checks the receipt and an event from the new InstantLayer.
9. Export removal of the old InstantLayer's Core/AccountLayer roles for the Dev Safe. The PartyB administrator separately removes its old trust and multicast permission. Final verification checks configuration, selectors, new wiring and retirement.

## Pause and recovery

Safe JSON export is a `waiting_external` stage, not proof of execution. Use **Continue active task** after executing each batch. Confirmed contract deployments and completed configuration actions are recovered from their journals and current state. A changed input, source, configuration, implementation or unrelated selector stops continuation. Unknown transaction outcomes are reconciled before another broadcast or cancellation.

The fork rehearsal contains only local transactions. Explorer publication, Safe execution, a production canary and final live verification remain separate evidence. A successful rehearsal does not authorize or prove any of them.
