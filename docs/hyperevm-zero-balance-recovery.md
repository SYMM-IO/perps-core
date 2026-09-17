# HyperEVM v0.8.5 zero-address recovery

Run `./symmio` and select **Other maintenance scripts → HyperEVM v0.8.5 / recover the zero-address balance**.

This workflow moves the entire available internal balance of address zero into the main multisig's **internal Core account**. It does not transfer ERC-20 tokens out of Core, withdraw allocated margin, or change another user's balance.

| Setting                          | Reviewed value                                            |
| -------------------------------- | --------------------------------------------------------- |
| Network                          | HyperEVM, chain 999                                       |
| Core                             | `0x57331038c21982116EE9b0906E4a5c5cB52dcE2e`              |
| Recipient Safe                   | `0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9`              |
| Core owner / recovery role admin | `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`              |
| Collateral                       | `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (6 decimals) |
| Internal balance precision       | 18 decimals                                               |
| Legacy AccountFacet              | `0xb6c0FD8B8721ECfb8De7782B9565DE5c8A5C468B`              |

The operator confirms the exact recipient address before deployment or recovery. No external approval reference or communication is required.

## Contract change

The add-only diamond cut installs `recoverZeroAddressBalance(address)` from `ZeroBalanceRecoveryFacet085`. It adds one selector, with no initializer, replacement, or removal. Existing nonzero suspended-account recovery keeps its original selector, implementation and collateral-decimal parameter.

The new method reads the raw `balances[address(0)]`, rejects zero amounts and zero recipients, clears the source and credits exactly that raw amount to the recipient. It preserves `SUSPENDED_FUNDS_WITHDRAWER_ROLE`, global/accounting pause checks and the v0.8.5 persistent proxy-signer guard. The event records the operator, recipient, full recovered amount and transaction-atomic recipient balances. A second call with an empty source reverts. Newly accrued funds would be a new recovery, requiring separate operational review.

The frozen storage declaration comes from v0.8.5 commit `6aace1560476374dc7002e677a45dbd48b30b6d1`. Only the first AccountStorage mapping is accessed. The production artifact must use `hardhat.recovery.config.ts`: Solidity 0.8.18, Paris EVM, optimizer 200 runs, via IR, no metadata bytecode hash. The runner checks build provenance, source, compiler output and deployed runtime. It refuses the main v0.8.6 build.

## Operator flow

1. Choose whether to run an optional fork rehearsal. **Default: no fork.** No archive endpoint is requested or used when skipped.
2. Select RPC and deployment wallet references. The deployment wallet is separate from the Core owner and recipient Safe.
3. Compile the isolated artifact and run its local contract and operation tests.
4. Read Core ownership, effective recovery-role administration, pause flags, persistent signer, collateral decimals, selector map, facet runtime hashes, Safe owners/threshold and raw balances.
5. Confirm the recipient address in the operator prompt.
6. If requested, run the fork rehearsal. A failed requested rehearsal stops the run; it is never silently treated as passed or skipped.
7. Review the live-operation summary and type `RECOVER ZERO BALANCE ON 999`.
8. Deploy one facet using the deployment wallet and publish its source on Hyperevmscan.
9. Connect the reviewed Core owner. Add the single recovery selector and grant the Safe the recovery role only if it was absent at baseline.
10. Export the recovery call as Safe Transaction Builder JSON. Import it into the **recipient Safe**, review and execute there. The call sweeps the full balance at execution; no amount is rounded or entered manually.
11. Choose **Continue active task** and provide the executed on-chain transaction hash, not a Safe proposal hash. Verify a successful canonical receipt, exact recovery event, current runtime/selector wiring and fresh source/recipient balances.
12. Remove only the recovery role temporarily granted by this task. A preexisting role remains intact.
13. Verify the final balances and generate `recovery-summary.txt`. The task displays the summary and completes.

The workflow never changes pause flags to make recovery succeed. Any unexpected selector, runtime, owner, collateral, pause/fee-collector or signer drift stops the operation for review. If the Safe balance changes after recovery, automatic reconciliation stops; investigate the intervening activity instead of treating a different current balance as proof of the sweep.

## Credentials

The normal flow needs the `RPC_HYPEREVM` and `ETHERSCAN_APIKEY` Hardhat configuration variables. Wallet selection supports the existing keystore, transient private-key and Ledger modes. No ambient deployment wallet or `.env` fallback is loaded by the isolated configuration.

Configure missing encrypted references through Hardhat's keystore, for example:

```bash
npx hardhat keystore set RPC_HYPEREVM --config hardhat.recovery.config.ts
npx hardhat keystore set ETHERSCAN_APIKEY --config hardhat.recovery.config.ts
```

Enter values in the secure prompt. Task inputs store key names only. A custom RPC key name can be chosen in the form.

For an optional fork, additionally configure a real archive endpoint under `RPC_HYPEREVM_ARCHIVE` (or another selected key name). The public HyperEVM endpoint [supports latest state](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) and is unsuitable as a historical fork source. The optional path probes historical code, pins a block/hash and compares fork balances against the archive snapshot before any rehearsal mutations.

## Evidence and proof boundaries

Outputs live under `tasks/data/999/zero-recovery/<input-digest>/`; Safe files are linked from `report.json`. Keep the input, report, Safe export, transaction receipts and summary together. Task-runner journals remain under `.symmio/tasks/`.

- **Local tests:** exact raw arithmetic, dust, two storage writes, unrelated balance preservation, empty/repeat recovery, unauthorized/revoked role, global/accounting pause, persistent signer, zero recipient, overflow, compiler provenance and interrupted transaction reconciliation.
- **Optional live-state fork:** additionally installs the facet through the deployed diamond, exercises the deployed nonzero suspended-account recovery and verifies selector preservation. Impersonation, gas funding, guard mutations and the synthetic legacy account exist only on the local fork.
- **Production evidence:** successful canonical receipts, verified deployed runtime, unchanged legacy selectors, the recovery event's before/after amounts and matching fresh balances. Without an archive endpoint, current runtime and fresh balances are verified; historical execution-block runtime is not independently read. The report distinguishes this from the optional archive-backed verification.
- **Summary:** the generated text contains the full recovered amount, recipient, recovery transaction link, upgrade transaction and raw before/after balances. The task completes after verification and temporary-role cleanup; it does not require sending a message or recording delivery.

Skipping the fork is recorded as not requested, never as a passed fork. Local checks and latest-state inspection do not establish full historical funding provenance for the zero-address balance.

## Resume and interruption

Use **Continue active task**, preserving the same checkout and task input. The source/configuration digest, exact transaction intent and nonce are bound to the run. Each live operation persists its intent before signing and hash before waiting. Resume validates the sender, chain, nonce, destination, calldata, value and canonical receipt before continuing.

A known pending or replaced transaction must be reconciled with its original or replacement hash. An interruption before the hash is recorded never triggers an automatic resend. Explicit wallet signature rejection is safe to retry; an uncertain transport failure remains unresolved. If no hash can be found, stop for nonce/transaction investigation rather than altering the report to bypass the guard.

Once a Safe export exists, continuation requests execution evidence instead of issuing a new sweep. An empty source alone does not prove the intended recipient was credited. Cancellation does not undo deployments or a diamond cut and remains blocked while a submitted operation's outcome is unresolved.

If the upgrade is installed but recovery cannot proceed, leave balances untouched and review the failing guard. Removing this one selector, if required, is a separate owner-approved rollback. A completed balance transfer is not automatically reversed. Preserve the receipt; any subsequent transfer requires a separate operational review.

## Developer verification

Use Node 22 with the existing dependencies:

```bash
npx hardhat test mocha --config hardhat.recovery.config.ts
node --test cli/test/hyperevm-zero-recovery.test.js cli/test/task-runner.test.js cli/test/operator-interface.test.js
npx tsc --noEmit --project tsconfig.operations.json
```

These commands are local tests and do not broadcast to HyperEVM. Production signing happens only through the explicitly authorized guided live phases.
