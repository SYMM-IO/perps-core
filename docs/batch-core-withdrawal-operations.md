# Batch Core deallocation and withdrawal

Run `./symmio` and select **Other maintenance scripts**. The batch workflow has three entries:

| Entry                                             | Behavior                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Batch deallocate and withdraw Core collateral** | Inspect and review every account, process transactions sequentially, and save waiting accounts.       |
| **Recheck pending batch withdrawals**             | Refresh request status and cooldowns from Core without entering private keys or sending transactions. |
| **Withdraw ready batch accounts**                 | Recheck a saved batch, review it, and withdraw the accounts that are ready.                           |

## First pass

1. Choose the network, Core diamond, recipient policy, amount, withdrawal interface, and Muon endpoint. Recipients can be each account's own wallet or one common address. Completed local batch runs suggest configuration for the same chain; the single-account withdrawal history is a fallback. Changing Core clears dependent defaults. Suggestions never copy transaction authorization, signatures, or keys.
2. Enter 1–100 public addresses, separated by commas or spaces, or import private keys one at a time using masked prompts. Addresses are derived from keys and duplicates are removed. Keys remain in memory and are not written to batch input, reports, task state, or history. Live execution asks for the corresponding private key only when an account needs to send. A later process or resumed session asks again. RPC credentials still use the existing network configuration.
3. Review the per-account balances, deallocation amounts, recipients, existing request IDs, request amounts, statuses, UTC cooldown deadlines, and totals. Type the displayed `BATCH WITHDRAW <chainId> <digest>` phrase to authorize the exact plan.
4. Process each account in order. Allocated collateral is deallocated as needed with a fresh Muon signature and a simulation from its owner. Classic withdrawals create a request for the frozen free balance; ready requests are finalized. Legacy withdrawals call `withdrawTo` once their cooldown finishes. A waiting or failed account does not stop other accounts.
5. Keep the displayed report path. The first pass finishes after eligible accounts have been processed and cooldowns saved. **A completed first pass does not mean every account has received its collateral.** Check the account statuses and verified withdrawn total.

`all` freezes the available free plus allocated collateral at inspection, rounded down to the collateral token's precision. A fixed amount applies to the new withdrawal from free/allocated collateral. Separately reviewed existing requests keep their original amounts and are included in the batch total. Locked funds in those requests are not requested again. Later earnings are not swept. Internal Core balances use 18 decimals; withdrawals use the collateral token's decimals. Totals are collateral amounts, not USD valuations.

This flow supports directly controlled EOAs using private keys and the existing `deallocate(uint256, SingleUpnlSig)` interface. Contract accounts, Party B accounts, suspended accounts, and incompatible deallocation interfaces require investigation. It does not change roles or close positions to make collateral available. Localhost rehearsal can use unlocked node accounts.

## Existing requests and cooldowns

The batch reads Core's per-account request counter and discovers request history at the inspected block, using paginated reads where installed. It adopts only pending requests with one same-chain part, the configured recipient, no express or virtual provider, no speedup, no advanced amount, and empty provider data. Provider requests, unexpected recipients, suspended/cancel-requested requests, or incompatible terms put that account into `needs_investigation` without sending.

For classic requests, the deadline is read from the request's current `cooldownEndTime`. For legacy withdrawals, the deadline is tracked from the account's current Core cooldown. A modified classic cooldown is rechecked from storage. A new request created outside the reviewed batch requires investigation; it is never silently adopted after authorization.

After cooldown, select **Recheck pending batch withdrawals** and choose the saved batch, or enter its `report.json` path. The report lists each adopted request and any new request made by the batch. It shows accounts as `ready`, `waiting_cooldown`, `completed`, `empty`, `planned`, or `needs_investigation`, with the next UTC deadline. Rechecking uses chain time and sends nothing.

Then choose **Withdraw ready batch accounts** for that saved batch. Review the report and authorize the displayed plan. Only ready accounts need a signing key. Confirmed deallocation is not repeated. If the first pass deallocated successfully but did not create its classic request, a ready pass can create and finalize that already-reviewed withdrawal once ready. It never starts a new deallocation.

Requests finalized externally are reported separately when adopted request storage proves completion. This does not count as a batch-verified transfer. A newly created batch request completed externally, a cancelled request, or unexpected balance changes require investigation rather than a duplicate payout attempt.

## Journals and recovery

The first pass saves `batch-withdrawal/input.json` and `batch-withdrawal/report.json` beside its runner event journal. The public input contains chain/Core/account/recipient configuration. The report contains frozen plans, block-pinned snapshots, discovered request history, per-account transaction intents and nonces, hashes, Muon responses when needed, cooldowns, failures, and transfer proofs. These are ignored local operator artifacts; retain them for follow-up. Use the registered tasks rather than editing these files.

Every transaction intent is saved before broadcast. Original and replacement hashes are reconciled against the exact caller, destination, calldata, value, chain, and nonce, then checked for a successful canonical receipt. Core events, token transfers to the reviewed recipient, and final request/account state must agree before a withdrawal counts as proven.

If a broadcast has an uncertain outcome, other accounts can continue, but the task remains waiting for reconciliation. Resume that task before opening a new withdrawal run. Supply the original or replacement transaction hash when prompted. The script never automatically resends an uncertain operation. Explicit wallet rejection before submission is retryable; failed simulations and unsupported requests remain visible for investigation.

Writes are sequential, and the Hardhat adapter uses a local Core checkpoint lock. This is not a distributed concurrency service. Avoid operating the same accounts from another process while a reviewed batch is in progress. Runtime changes and Core/collateral upgrades stop continuation until the original evidence is reconciled. Cancellation preserves existing transactions and does not cancel on-chain requests.

## Verification

Batch tests cover mixed allocated/free/pending/blocked accounts, both withdrawal routes, common recipients, masked key import, same-account recovery, lost broadcast responses, missing transfer evidence, external request changes, and later ready passes without duplicate deallocation. A local EVM rehearsal runs the real Hardhat adapter against the Core fixture: deallocation, existing request adoption, cooldown continuation, and exact collateral transfer verification. Its Muon response uses the fixture verifier. This proves local integration; it does not execute a withdrawal or validate an oracle response on a live deployment.

Reproduce the checks using the repository's pinned Node version:

```sh
npm run test:cli
npm run test:scripts
npm run test:deploy
npm run lint:ts
```
