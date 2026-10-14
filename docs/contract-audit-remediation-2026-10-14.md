# Contract audit remediation — 14 October 2026

Branch: `fix/contract-audit-2026-10-14`. Base: `1338f181f4b17e38d58989248374dc0f4b28897d`.

## Implemented behavior

- **F-001:** PartyB batch oracle verification requires one price per quote ID before hashing or consuming prices. The Muon message format is unchanged.
- **F-006:** `SymmioGlobalRelayer` accepts only the configured source-core/account-manager pair and rejects nested transfers. A new or upgraded relayer starts with no enabled sources.
- **F-007:** Each template result insertion requires an exact signed 32-byte flex field at that offset. Its authorized filler must be the executor or must sign the actual inserted word. A template cannot rewrite a fixed argument in an ordinary batch signature.
- **F-008:** A transient instant-open scope tracks its newly created quotes and cannot close with any still unopened. Ordinary quotes cannot enter the shortcut path, and atomic quotes cannot leave it through a suspended hook. Persistent direct-core instant-open mode retains the full-fill rule but uses normal pending bookkeeping across transactions.
- **F-009:** A new liquidation settlement records its allocation key when that PartyB bucket is created. Later settlement debits and CVA releases use the recorded key even after a PartyB mode switch.
- **F-010:** Muon public-key registration rejects zero/out-of-range X coordinates and invalid parity.
- **F-012:** Fee claims require a currently whitelisted core belonging to the affiliate. Distribution requires receipt of the requested collateral amount. Inactive affiliates can still claim legitimate accrued fees from their approved cores.
- **F-013:** AccountLayer increments a root-account ownership epoch on transfer. InstantLayer grants capture that epoch; previous grants cannot execute after a transfer or revive when ownership returns. Timelock policies and schedules remain intact. Migration does not promote an earlier-epoch grant into the current epoch.
- **F-014:** A different PartyB may settle only with the PartyA whose force-close workflow is active. The workflow no longer grants privileges over an unrelated PartyA/PartyB pair. A same-PartyB cross settlement can still realize funds from its other counterparties.
- **H-004:** A position with zero LF can close when symbol configuration deliberately allows zero LF. Positive LF still requires a nonzero proportional release for a partial close.
- **OVERDUE netting:** New liquidations first aggregate full PnL, including funding, per PartyB. Only negative net buckets are haircut, using their combined net loss as the denominator. Net-flat and positive buckets are preserved. The final payment plan is computed after all quote batches, before settlement, and respects dispute overrides. Payouts round down so multiple losing buckets cannot create excess collateral claims. Settlement and recursive position processing are blocked during close hooks until netting, rounding and dispute checks finish.

## Integration and upgrade requirements

The `SignedOperation` struct, EIP-712 operation type, and existing external execution selectors are unchanged. Template clients must add signed flex-field entries for every insertion offset and provide corresponding fill/signature array entries. An empty fill (`0x`) leaves the word for template injection; it does not waive filler authorization. An executor-authorized field needs no separate filler signature. A different filler signs `FlexFillAuth` for the actual injected value. Existing fixed-argument signatures remain usable through `executeBatch` and through template slots without insertions.

Upgrade the affected core facets and their linked implementations together. `PartyBBatchActionsFacet` now links to the existing `PartyBPositionActionsFacetImpl` library for the shared open transition; deploy a new implementation library containing `openPositionState` and link the batch facet to that address. The deployment manifest includes this dependency. The transition still executes by library delegatecall in core storage with the original caller, checks, hooks and events.

Upgrade AccountLayer Core/View and InstantLayer Delegation/Execution/View/Migration together while the affected routes are paused. The new AccountLayer view selector is `getAccountOwnershipEpoch(address)`. The new InstantLayer view selector is `delegationOwnershipEpoch(address,address,bytes4)`. InstantLayer fails closed for active grants if the AccountLayer epoch getter is missing. These selectors must be added by the Diamond cut.

Storage changes are append-only mappings in AccountLayer `AccountStorage.Layout` and InstantLayer `DelegationStorage.Layout`, plus a separate `LiquidationSettlementStorage` namespace in core. Existing public account, quote and liquidation tuples are unchanged. A zero epoch preserves grants on accounts with no recorded transfer. Transfers that happened before this AccountLayer upgrade cannot be reconstructed automatically: review/revoke existing grants on those accounts before enabling execution.

The new netting flag applies to liquidations started after the upgrade. Existing in-flight liquidations retain their previous payment plan. A pre-upgrade PartyB settlement without allocation metadata uses the legacy key resolution. Settle those liquidations before upgrading, or pause mode changes and resolve their original buckets explicitly; an upgrade does not infer historical allocation keys or repair earlier payments.

Existing quotes created by the old instant-open shortcut without pending reservations/arrays need separate recovery. The new checks prevent additional malformed quotes; they do not reconstruct missing historical bookkeeping. Ordinary pending quotes should open through ordinary bookkeeping rather than an atomic template.

For a relayer upgrade, configure each reviewed pair with `setSourceMultiAccount(source, multiAccount)` before resuming transfers. Passing a zero manager disables that source. Validate the account manager's implementation and upgrade authority; the mapping is an administrative trust boundary. Relayer storage fields are appended after its existing mappings.

## Deliberately unchanged

ADL price discretion, accumulated-funding rate policy, and mutable affiliate trading fees remain product/trust decisions (F-002/F-003/F-004). The documented symbol-adjustment freeze (F-005), affiliate-level reusable Express capacity attestations (F-011), zero-means-unlimited credit caps, and accepted ledger-only Express `coverLoss` behavior remain unchanged.

No deployment, live role mutation, or historical balance reconciliation is part of this branch.

## Verification

Compiler storage-layout comparisons against the base commit used Solidity 0.8.36 standard JSON output, separate harnesses for the namespaced structs, and the relayer's inherited layout. Every pre-existing member retained its slot, offset and recursively compared type: 13 AccountLayer account fields, 5 InstantLayer delegation fields, and both relayer fields. New mappings occupy the next slots (13, 5 and 2 respectively); the relayer guard occupies slot 3. Core `AccountStorage.sol` and `QuoteStorage.sol` are byte-for-byte unchanged.

`npm run lint`, formatting checks for all changed Solidity/TypeScript files, and `git diff --check` pass. Compilation and the production size check pass: 261 deployable artifacts, 5 size warnings, no size failures. The largest changed library is `LibPartyALiquidationProcess` at 23,354 bytes, within the 23,552-byte release budget.

The final full run passed **3,683 tests across 132 suites** using `DOTENV_CONFIG_PATH=/dev/null USE_KEYSTORE=false PARALLEL_JOBS=2 npm test`. An earlier four-worker run encountered six timeouts and two outdated expectations (the additive epoch view and the corrected net-loss haircut). Those expectations were updated, all affected suites passed separately, and the final full run had no failures. Regression coverage includes quote/settlement order, net-flat and positive solver buckets, payout rounding, partial-batch disputes, callback settlement, template injection, filler signatures, atomic quote lifecycle, ownership transfer/migration, real-collateral relayer transfer, approved-core fee receipt, oracle array shape, force-close scope, and zero-LF closure.

Independent source reviews covered execution authorization, context lifecycle, ownership epochs, liquidation accounting, and perimeter checks. A review caught the final-close callback settlement window; the processing guard and callback regression close that issue.
