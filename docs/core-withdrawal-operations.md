# Core account deallocation and withdrawal

Start `./symmio` and choose **Other maintenance scripts**. Two tasks are available:

- **Check Core balance and withdrawal readiness** (`maintenance.core-withdrawal-check`): reads the account, token decimals, allocated/free balances, installed interfaces and withdrawal cooldown. No signer, Muon request or transaction is used.
- **Deallocate and withdraw Core collateral** (`maintenance.core-withdrawal`): review an exact amount and recipient, deallocate if needed, wait for the on-chain cooldown, withdraw, and verify the receipt and collateral transfer.

Use the pinned Node version and existing installed dependencies. The runner uses the existing network registry and RPC credential resolution. Live RPC credentials come from the network's Hardhat keystore entry (for example `RPC_BSC`); no private RPC URL or key is saved in task inputs. Signing uses the selected Hardhat keystore wallet, Ledger, or transient private key. Local rehearsal can use an exact unlocked localhost account. The selected signer must equal the account holding the balance.

## Operator workflow

1. Select the network and enter the Core diamond, account, and recipient. The most recent completed withdrawal suggests the network. If that network has completed withdrawals, choose a dated previous configuration or **Enter a new configuration**. Every value remains editable; the task is not tied to a chain or liquidator address.
2. Select **Deallocate as needed, check cooldown, then withdraw**, **Deallocate only**, or **Withdraw existing free balance only**.
3. Enter a positive token-unit amount such as `180.590469769171672952`, or `all`. For withdrawal, existing free balance is used first; only the shortfall is deallocated. `all` is resolved once at inspection and frozen in the approved plan. Later credits are not swept by the same run. A newly started run is a new intent, not a continuation of a completed withdrawal.
4. Choose automatic, classic, or legacy withdrawal. Automatic uses the classic request flow when all required selectors are installed; otherwise it requires `withdrawTo`. Interface and collateral bytecode bindings are saved and rechecked before subsequent actions. The legacy route is probed before deallocation; an unavailable/deprecated route is not silently substituted after approval.
5. Enter the Muon HTTPS root or `/v1/` endpoint. For example, `https://muon-oracle3.rasa.capital/`. The URL cannot contain credentials, query parameters, or fragments. The endpoint receives the public chain, Core and account identifiers.
6. Review the account, recipient, collateral, exact amount, route and cooldown. Type the displayed chain-and-plan confirmation, then approve the wallet transaction(s).
7. If cooldown remains, the task becomes **waiting_external** with the exact UTC timestamp. Return to `./symmio` and resume this same task after that time. Do not start another deallocation: it may reset the cooldown. The resumed task checks chain time again and does not replay confirmed operations.
8. Completion requires the exact Core withdrawal event, an ERC-20 transfer from Core to the reviewed recipient, the expected Core balance changes, and classic request completion where applicable. Deallocation-only completion verifies the internal movement; it does not claim an external transfer.

## Supported interfaces and units

Deallocation uses `deallocate(uint256, SingleUpnlSig)` for a directly controlled Party A or liquidator wallet. It fetches `app=symmio&method=uPnl_A` immediately before the operation, maps the gateway/Schnorr fields, verifies response identity and account nonce, requires at least 15 seconds of remaining validity, and runs `eth_call` from the actual account. Signature acceptance is ultimately checked by Core, not just by the oracle's `success` field. The validity window is read from Core, including the AccountManagement override when exposed. Slow hardware-wallet approval may outlast the signature; receipt reconciliation is required before another attempt.

Suggestions come from completed `maintenance.core-withdrawal` runs in the runner's local history (`.symmio/tasks/history`, or the configured task state directory), newest first. They are isolated by network and chain ID. Read-only checks, cancelled, failed and unfinished runs are excluded. Both the check and withdrawal tasks can use this history; a first run keeps the normal manual prompts.

A selected run suggests Core and account, plus recipient, amount, operation, interface and Muon endpoint. Changing Core clears all dependent suggestions; changing account clears recipient, amount and operation. The recipient then defaults to the newly entered account. Interface and Muon endpoint suggestions require the same Core. A suggested `all` resolves against fresh balances, and a fixed amount is checked again before approval. Suggestions are configuration only: signing credentials, approval, signatures, request IDs, transactions and prior readiness are not copied. The new run still fetches fresh signatures when needed, previews and confirms its plan, journals its own transactions, reads the current cooldown and verifies the final transfer.

The task deliberately refuses contract accounts (including AccountLayer, Safe and CallProxy accounts), Party B balances, suspended accounts, and deployments that disable this legacy deallocation signature. These require their own account/caller or newer-signature adapter. It never grants roles or substitutes an administrator for the balance owner. The read-only check can still report these accounts, but does not establish transaction eligibility.

Withdrawal supports:

- **Legacy:** `withdrawTo(recipient, amount)` after the cooldown.
- **Classic:** one same-chain `initiateWithdraw` part with the exact recipient and amount, both providers zero, `speedUp=false`, and empty provider data; then `finalizeWithdrawRequest(account, requestId)`. The request ID comes from the confirmed receipt and is checked against Core storage on resume. No virtual, express, bridge, or existing externally-created request is adopted.

Internal balances and deallocation amounts use 18 decimals. Withdrawal amounts use the collateral token's decimals. The script supports collateral with 0–18 decimals, rejects excessive precision on explicitly entered withdrawal amounts, and rounds `all` down to token precision while leaving dust in Core. It never treats token units as USD. No ERC-20 approval is needed to withdraw.

## Evidence and recovery

Each run stores `core-withdrawal/input.json` and `core-withdrawal/report.json` beside its runner event journal. The report contains the immutable plan, pinned snapshots, latest full Muon response and mapped signature when requested, expiry, exact action calldata, write-ahead transaction intents/nonces, receipts/proofs, readiness and final state. These files are local ignored operator evidence; back them up when needed. Muon signatures expire and must not be reused from saved reports.

A transaction intent is saved before signing, and its hash before waiting for confirmation. After a receipt first appears, the common transaction layer waits up to 30 seconds for a successful receipt with a non-zero block hash matching the canonical block. It refreshes the receipt, block and requested confirmation depth on each pass, including during recovery. This handles preconfirmed L2 receipts and RPC propagation delays. A persistent mismatch or non-responsive RPC leaves the hash journaled, stores the observed receipt and block hashes, and pauses for reconciliation; it never resends the transaction. The shared implementation also applies to deployment, role/configuration and other operations that use `send()`. A restart reconciles original or replacement transaction identity, nonce, successful receipt, canonical block and expected events before continuing. Unknown/no-hash outcomes are never automatically resent. Supply the original or replacement hash when prompted. A confirmed revert, changed-intent replacement, or unresolved transaction keeps the task blocked for operator reconciliation; the task does not guess that retrying is safe. Explicit wallet rejection before submission can be retried with a fresh signature. Cancellation stops future writes and preserves proven partial effects; it does not undo a deallocation or cancel a classic request.

External balance changes or facet upgrades after approval stop execution. Reconcile any pending operation first, then cancel and review a new plan for the changed state. A mined receipt without matching accounting/transfer evidence does not count as successful completion.

The underlying Hardhat adapter defaults to inspection and requires the shared `EXECUTE=true` plus matching `CONFIRM_CHAIN_ID` interlock for sending. Operators should use the registered `./symmio` tasks, which own confirmation, signer prompts, journaling, pause and resume.

## Signer configuration and restarting an empty run

Read-only inspection, cooldown checks and reconciliation configure no signing accounts. They may still resolve RPC credentials from the Hardhat keystore. Private-key execution uses the transient key supplied through the masked signer prompt; only the keystore signer flow requests the selected signing entry (default `NEW_DEPLOYER`). Do not add a deployer key to fix a private-key inspection failure.

Older versions could fail before inspection with `HHE7: Configuration Variable "NEW_DEPLOYER" not found`. After updating, a paused run is subject to the normal source-change guard. If it has zero completed steps, no journaled transactions and no operation evidence, choose **Cancel active task**, then start the withdrawal task again and select your signer. If transaction evidence exists, reconcile it before cancelling or restarting. Do not edit the saved source hash to bypass the guard.

## Validation boundary

Automated tests cover both withdrawal routes, six-decimal token accounting, exact amounts and dust, Muon identity/nonce/expiry rejection, dry-run behavior, cooldown continuation, completed-operation replay, unknown broadcasts, replacements/reverts, Ledger-compatible gas/fee completion, unexpected balance changes and missing token-transfer proof. Shared runner/signer/PTY tests cover the reused execution infrastructure.

A live BNB read-only check during development observed that the example liquidator had already deallocated: the workflow skipped deallocation, read its free balance and reported the remaining cooldown without any broadcast. The matching BNB fork rehearsal could not obtain historical state from the public RPC (`missing trie node`). A complete on-chain fork rehearsal remains required before treating this as production-validated for a particular deployment. Local transport tests and live read-only checks are not execution proof.
