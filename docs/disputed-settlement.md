# Disputed account settlement with admin signing

Start `./symmio`, then select **Other maintenance scripts → Settle a disputed account using Clearing House**. Use the checkout's Node version from `.node-version`.

The task loads one JSON case file, calculates the payout shares from a pinned chain snapshot, writes a human-readable review, and asks the named administrator to sign the exact transactions. Ledger is the default signer; an existing Hardhat keystore wallet is also supported. The selected wallet must match `operator` in the file. This workflow uses the administrator directly; it does not produce a Safe batch.

## Input file and payout rules

The prefilled [Arbitrum case file](../tasks/config/disputed-settlement.arbitrum-652b2e.json) identifies Party A `0x652b2e3e3850801ed22c600b13535fbcf93b2664`, Core, Account Layer, collateral, chain and expected admin wallet. Copy this file for another case and change its identities and payout rules. No key or RPC credential belongs in this file. The wallet's current authority and the deployment wiring are checked when the task runs.

```json
"shares": {
  "solver": {
    "pnlBps": 10000,
    "fundingBps": 10000,
    "cvaBps": 10000
  },
  "liquidator": {
    "basis": "remainderAfterSolver",
    "shareBps": 0,
    "recipient": "0x77A955776Ee1dd3E9C800c3214ed489441d74b94"
  },
  "remainder": "parent"
}
```

`10000` basis points means 100%; `2500` means 25%; `0` means zero. The filled policy credits 100% of recorded solver PnL, funding and CVA, disables the liquidator/operator fee, and returns the remainder to the virtual account's parent. These are explicit administrator-approved distribution rules, not an automatic conclusion that every disputed case should use these percentages.

For each solver and market, the calculation is:

1. Sum the matching liquidation events' signed PnL and funding. Read the matching fully liquidated quotes' CVA. Reconcile these totals against the still-pending settlement bucket.
2. Multiply each market component by its configured basis points and divide by 10000 using integer arithmetic, rounding toward zero. Sum the calculated components for the solver credit.
3. Calculate the liquidator fee from either `remainderAfterSolver` (Party A allocation minus solver credits) or `recordedLiquidationFee` (the original on-chain fee). Multiply by `shareBps / 10000`, rounding down. A nonzero fee credits the declared recipient's **Core allocated balance**.
4. Return `Party A allocation − total solver credits − liquidator fee` to the discovered parent's **Core balance** on finalization. Unassigned rounding units remain in this return.

The solver percentages apply to every discovered solver and market in the case. Signed PnL and funding retain their sign. A net solver debit or a credit to Party A reimbursement requires a different reviewed settlement policy and is rejected here. No amounts use JavaScript floating-point arithmetic.

All amounts are internal **18-decimal collateral accounting units**, even when the underlying token uses six decimals. This task does not withdraw tokens to a wallet. The explicit settlement interface represents solver PnL plus CVA as `realizedPnl`, funding as `funding`, and the optional liquidator credit as `platformFee`. The review shows that classification and the exact encoded rows.

## Arithmetic for the filled case

The following is the earlier inspection's arithmetic, retained as a review example and calculation-test fixture. It is **not a fresh balance assertion**. The menu task recalculates from chain state before approving any transaction.

| Component               |                                 Recorded amount | Configured share |        Calculated amount |
| ----------------------- | ----------------------------------------------: | ---------------: | -----------------------: |
| Solver PnL              |                            2.493108170448664277 |             100% |     2.493108170448664277 |
| Solver funding          |                            0.053876144664567485 |             100% |     0.053876144664567485 |
| Solver CVA              |                            0.895588429244244328 |             100% |     0.895588429244244328 |
| **Solver total**        |                                                 |                  | **3.442572744357476090** |
| Liquidator/operator fee |                  0.579974554669831643 remainder |               0% |                    **0** |
| **Parent return**       | 4.022547299027307733 − 3.442572744357476090 − 0 |                  | **0.579974554669831643** |

The original recorded liquidation fee was 0.579974554669832589. Paying that full amount as well as all three solver components would exceed the available allocation by **946 raw accounting units**. The task rejects an overfunded payout; it never silently reduces a recipient's share or clamps the fee.

## Admin review and signatures

Choose the configured network RPC from the Hardhat keystore, or explicitly select public Arbitrum RPC. The selected RPC receives the account reads and, during execution, the simulation and transaction data.

Before signing, inspect `review.txt`: it contains the snapshot block, liquidation ID, chain, Core, signer, every recipient, per-market calculation, liquidator fee basis, parent subtraction, and every transaction's method, arguments, zero native value and calldata. Type the exact confirmation phrase displayed by the task to bind approval to that plan.

When the admin does not already have `CLEARING_HOUSE_ROLE`, the five transactions are:

1. Grant that role to the named admin wallet.
2. Take over this disputed liquidation.
3. Apply the calculated settlement once.
4. Finalize takeover and return the remaining allocation through the Account Layer hook.
5. Revoke the role granted by this task.

An existing clearing-house role is preserved: no grant or revoke is generated. If every configured payout is zero, the empty settlement call is omitted. The admin must have authority to administer the role; ownership alone is not used as proof of that authority.

Every transaction is simulated with `eth_call` from the actual sender against the current state immediately before signing and is supplied with explicit gas and fee fields for Ledger. These are separate transactions. A later failure can leave takeover active or a temporary role in place; continue the same task to finish it.

## Evidence and recovery

Case evidence is saved under `tasks/data/<chainId>/disputed-settlement/<run-id>/`:

- `input.json`: immutable copy of the selected share file.
- `review.txt`: the admin's formulas and decoded transaction review.
- `report.json`: the bound plan, source digest, write-ahead intents/nonces, transaction hashes, receipt evidence and verified final state.

Use **Continue active task** after interruption. Confirmed actions are reconciled and never automatically sent again. An uncertain send requires the original or replacement transaction hash; reconciliation verifies sender, target, calldata, value, chain, nonce, successful receipt and canonical block. If signing failed without a hash and without an explicit device rejection, the intent remains unresolved until that outcome is investigated. Editing the reviewed input, code, plan or deployment state refuses further writes.

Cancellation sends no compensating transactions and does not reverse a takeover, payment or role grant. Retain the evidence directory. Unknown transaction outcomes remain unresolved. Keep an unfinished operation paused and use **Continue active task** to preserve the original report and policy. Cancelling archives the task; subsequent recovery requires review of the retained report rather than starting a fresh payout case.

Final verification requires exact receipt events for settlement components, each account credit and the parent return, plus fresh state proving that liquidation, takeover, pending settlements and the virtual account were cleared and that the original role state was restored. Receipt success alone is insufficient.

## Supported cases and verification boundary

This version supports NORMAL disputed liquidations of existing Account Layer virtual accounts, after every position and pending quote is closed, with registered isolated Party Bs. It requires complete matching liquidation events, matching settlement buckets, and zero Party A free balance, reimbursement, deferred balance and clearing-house pool. Deficit liquidations, cross Party Bs, already-started takeovers and other accounting states stop for a separate policy review.

The local tests cover exact share arithmetic, insufficient collateral, multi-market rows, role preservation, real ABI encoding/decoding, dry execution, signer binding, Ledger fee fields, interrupted payment recovery, duplicate prevention and failed final-state proof. The focused ClearingHouse contract tests cover the underlying settlement behavior. A matching fork rehearsal remains necessary before treating this as a validated production execution. No live transaction is implied by these tests.
