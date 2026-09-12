# Arbitrum AccountLayer and InstantLayer upgrade

Launch `./symmio`, select **Other maintenance scripts**, then **Arbitrum AccountLayer and InstantLayer upgrade — preserve current values**.
Task ID: `maintenance.arbitrum-account-instant-upgrade`. Task version 7 has 18 steps; select the `TEAM_DEPLOYER` keystore signer for deployments.

This task upgrades AccountLayer `0x5733107211B2801Acd39933a54d482FE303c4907`, replaces InstantLayer `0x2C9e944cB71329fC659Da50A10a79a508Dd49ba5`, and upgrades the implementation behind GaslessLayer `0x386EF97D913acf02B3C9452da4Cd4aaEc82eFBca`. Core `0x573310dB6d160B26026B8706EBe9831c7dEF1D09` keeps its installed facets.

## Input and current values

Review `tasks/config/arbitrum-account-instant-upgrade-42161.json` before starting. It fixes target addresses, the Dev Safe as the PartyB wiring authority, the old Gasless source commit, and the preservation policy. The existing production recipe supplies RPC/explorer credential references; its deployment settings and template defaults do not supply the upgrade's configuration values.

Each run creates `tasks/data/42161/account-instant-upgrades/<run>/` containing:

- `input.json`: target/policy, exact source commit and recipe digests.
- `configuration-input.json`: configuration read from one pinned Arbitrum block, discovery evidence, selector maps and runtime hashes.
- `fork-recipe.json`: the same credential references targeting the local fork.
- `report.json`: deployment addresses, compatibility checks, transactions, rehearsal and verification evidence.
- `client-upgrade.json`: deployed addresses, full Gasless/InstantLayer ABIs, new InstantLayer signing domain, disabled creation-fee policy and fee-quote/limit cutover instructions. The task exports this before Gasless cutover and binds the operator acknowledgement to its digest.

Safe Transaction Builder batches are exported under `tasks/data/42161/safe/` for the AccountLayer cut, InstantLayer configuration, PartyB wiring, protocol wiring, and the two retirement stages. Each stage has its own reviewed intent and resume binding.

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

1. Compile and inspect current state. Restore the complete historical project dependency graph from the pinned Gasless baseline commit, then match its implementation and all four linked libraries to live bytecode. Compare storage against the narrowly permitted indexed-wallet change described below. Rehearse deployment, cut, configuration, wiring and retirement on the exact snapshot fork. Any failure stops deployment.
2. Review current values and the required flow permissions, then authorize chain `42161`. Use a separate deployment wallet; it receives no Core, AccountLayer or Gasless administration roles. The replacement InstantLayer constructor gives administration directly to the Dev Safe.
3. Deploy **thirteen contracts**, in order: `LibQuoteParams`; AccountLayer `CoreFacet`, `MarginFacet`, `ControlFacet`, `ViewFacet`, `TimelockFacet`; `InstantLayer`; `GaslessNativeGasTopUpLib`; `GaslessOperationalFeeLib`; `GaslessWalletDeployerLib`; `GaslessWalletExecutionLib`; `GaslessFeeQuoteLib`; and the `GaslessLayer` implementation. Link the execution library to the new deployer library, the quote library to the new operational/execution libraries, and Gasless to all five new libraries. All Gasless libraries are freshly deployed; baseline addresses are retained only for verification. Publish all thirteen new contracts on Arbiscan.
4. Export the AccountLayer cut for Dev Safe `0x89bE952790657297ac03f1954b22B668d819D3d9`. Execute it in the Safe, then continue. The cut has no initializer. The task verifies every installed selector before proceeding.
5. Export the replacement InstantLayer configuration for the Dev Safe. The batch copies the selected whitelist, all templates and their exact flags/offsets, cooldown and transient mode; registers the supplied PartyBs; and grants the required Gasless/PartyB operator permissions. The Safe retains administration. Continuation verifies the resulting values and flow roles before wiring Gasless to it.
6. Export Enigma PartyB wiring for the Dev Safe. `policy.partyBExecution: "safe"` requires `target.partyBAdmins` to select `target.safe`. On PartyB `0x9be79D4977D86D440F9e1Ea0d468A58104B9b932`, the batch first grants the Safe `MANAGER_ROLE` if it needs that role to update the whitelist, then grants the new InstantLayer `TRUSTED_ROLE` and enables its multicast whitelist entry. Each call is omitted if already satisfied. Execute the batch through the Safe, then continue; Gasless cutover waits until direct reads confirm the new trust and whitelist. The CLI does not request the former PartyB administrator's wallet.
7. Review `client-upgrade.json`. Stage the relayer/client ABI, InstantLayer signing domain and event-consumer changes for activation with the Gasless upgrade. Acknowledge readiness in the CLI; otherwise it waits before exporting the cutover batch. This records operator readiness, not proof that external services have been deployed.
8. Export the protocol wiring batch for the Dev Safe. It grants missing Core `INSTANT_LAYER_ROLE` and AccountLayer `INSTANT_LAYER_ROLE` / `SIGNER_SETTER_ROLE` to the new InstantLayer, `RELAYER_ROLE` to `target.relayer` on Gasless, and `ACCOUNT_CREATOR_ROLE` to Gasless on AccountLayer. It registers Gasless as a Core operational-fee charger when missing, retaining its receiver. If needed, the Safe grants itself Gasless `CONFIG_ADMIN_ROLE` or Core `FEE_ADMIN_ROLE` using its existing default-admin authority. The final action atomically calls Gasless `upgradeToAndCall(newImplementation, setInstantLayer(newInstantLayer))`. Already-satisfied actions are omitted. Verification checks preserved settings and each required permission.
9. Activate the staged clients when the Gasless upgrade executes. Use the new InstantLayer address and signing domain, and grant fresh user delegations as needed. Execute a real delegation grant or ordered-nonce operation through the preserved Gasless proxy. Supply its successful transaction hash; the task checks the receipt and an event from the new InstantLayer.
10. Export removal of the old InstantLayer's Core/AccountLayer roles for the Dev Safe. Export a separate Safe batch to remove the old layer's PartyB trust and multicast permission, adding a manager grant first if needed. Final verification waits for execution, then checks configuration, selectors, new wiring and retirement.

The selected relayer needs `RELAYER_ROLE` on Gasless. The InstantLayer `OPERATOR_ROLE` recipients are Gasless and the supplied solver PartyBs; the relayer is not granted direct Core/AccountLayer administration or InstantLayer execution authority. The Dev Safe must already have upgrade/default-admin authority on the existing protocol contracts, including PartyB. PartyB preflight checks its actual role-admin relationships: the Safe must administer `TRUSTED_ROLE` and either hold `MANAGER_ROLE` or be authorized to grant it. Whitelist updates require `MANAGER_ROLE`; `SETTER_ROLE` is not required for this stage. Existing PartyB administrators retain their permissions. If the Safe cannot authorize a needed grant, the task names the missing authority instead of exporting an unexecutable self-grant.

## Indexed-wallet compatibility and client changes

The baseline nonce mapping `walletOperationNonces` stays at slot 18 with its original `mapping(address => uint256)` type and values, renamed privately to `_legacyWalletOperationNonces`. The new nested `walletNonces` mapping occupies slot 19. The new `walletCreationFee` uint256 uses slot 20. The reserved gap moves from slot 19 with 33 words to slot 21 with 31 words; its end remains unchanged. The validator rejects any other field, slot, offset, type, nonce rename or gap change. These storage checks are separate from live runtime parity and configuration getter checks. The new fee-quote accounting namespace is `keccak256("symmio.gaslessLayer.feeQuote.v1")`; the four context slots must be empty before and after the upgrade and completed executions.

The existing Gasless proxy address is retained, so wallet ID `0` preserves the original CREATE2 wallet address and signer-account nonce stream. Positive wallet IDs have separate addresses and nonce storage. This preservation applies to **Gasless wallet state**; the replacement **InstantLayer user state** is intentionally not migrated.

Existing Gasless callers need the new ABI even where the function names are unchanged:

| Function                         | Required caller change                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relayInstantBatch`              | Append `walletIds`, one per signed operation; use `0` for ordinary InstantLayer operations and the original wallet.                                             |
| `getGaslessWalletAddress`        | Pass `(owner, walletId)`.                                                                                                                                       |
| `settleDepositToNewAccount`      | Pass `(owner, walletIndex, affiliate, data)`.                                                                                                                   |
| `settleDepositToExistingAccount` | Pass `(owner, walletIndex, subAccount)`.                                                                                                                        |
| `recoverNonCollateralToken`      | Pass `(owner, walletId, token, recipient)`.                                                                                                                     |
| `getAccountOperationalFee`       | Pass `(account, signedOps, walletIds)`.                                                                                                                         |
| `walletOperationNonces`          | Replace the old signer-only getter with `(owner, walletId, signerAccount)`; it returns the last consumed nonce, so the next operation uses that value plus one. |

`relayInstantTemplate`, `relayGrantBatchDelegationBySig` and `relayNativeGasTopUp` retain their call signatures. Update event consumers for `GaslessWalletDeployed`, `WalletDepositSettled`, `WalletNonCollateralTokenRecovered`, `WalletCreationFeeUpdated` and `WalletCreationFeeCollected` using the exported ABI. Wallet-operation signatures retain the `GaslessGateway` domain at the same proxy and sign the selected wallet target. InstantLayer signatures instead use the new address with domain name `SymmioInstantLayer`, version `1`, chain `42161`.

The original implementation has no wallet-creation fee getter. The upgrade reads its reserved slot 20 directly and requires zero, preserving the absence of that charge. It records `fees.walletCreationFee: "0"` in the configuration snapshot and verifies the new getter after cutover. It does not run an initializer or `setWalletCreationFee`, and does not copy the new-contract recipe's fee setting. A nonzero slot or failed read stops the task for investigation; it is never treated as a default. Enabling this fee is a separate configuration change requiring an explicit amount.

For the new fee APIs:

- `previewFeeQuote(callData, nativeAmount)` estimates charges from current state without validating signatures or executing the request.
- `simulateFeeQuote(callData)` runs the complete request through `eth_call`, using the actual submitting relayer/admin as `from` and the intended native `value`. Success is encoded in the `FeeQuoteResult` revert; failures are wrapped in `FeeQuoteExecutionFailed`. Use `quoteGaslessFee` in `scripts/gaslessLayer/fee-quote.ts` to distinguish them. Never broadcast the simulation method.
- `executeWithFeeLimit(callData, maxTotalDebit)` executes the same encoded action under its normal roles and reverts atomically if its Gasless debit exceeds the cap.
- All quote amounts and debit caps use **18 decimals**. The creation-fee setting and creation-fee events use **collateral token decimals**. `totalDebit` includes collateral exchanged for native gas; `totalFee` excludes that exchanged principal. Quotes exclude Core trading fees, bridge fees and transaction gas.
- Optional operation/delegation caps must be included via `gaslessFeeLimitSalt` before signing. Capped native top-ups use `signCappedNativeGasTopUp`. Untagged legacy salts and legacy top-up signatures retain their existing behaviour; the upgrade adds no global fee cap setting.

The production canary verifies a successful Gasless receipt and a delegation-grant or ordered-nonce event emitted by the replacement InstantLayer. It is not proof of every deposit, indexed-wallet or solver path; those paths need their own client acceptance checks when used.

## Pause and recovery

Safe JSON export is a `waiting_external` stage, not proof of execution. Use **Continue active task** after executing each batch. Confirmed contract deployments and completed configuration actions are recovered from their journals and current state. A changed input, source, configuration, implementation or unrelated selector stops continuation. Unknown transaction outcomes are reconciled before another broadcast or cancellation.

PartyB batches use the same `waiting_external` flow as the other Safe stages. Continuing without execution leaves the step pending. The planner computes only missing calls, but changing a previously exported pending batch is refused by the Safe intent binding; execute the reviewed batch as a whole. The fork rehearsal simulates the PartyB calls locally under the Safe's address to validate role grants, wiring and retirement.

For a run stopped during initial discovery with only compilation complete and no journaled transactions, a source/configuration fix requires **Cancel active task**, then starting this maintenance task again. Reopen `./symmio` first to load updated code. The fresh run copies the updated input and pins the new source; do not edit the paused run's hashes to bypass drift checks. The flow-specific discovery no longer uses historical log queries.

The fork rehearsal contains only local transactions. Explorer publication, Safe execution, a production canary and final live verification remain separate evidence. A successful rehearsal does not authorize or prove any of them.
