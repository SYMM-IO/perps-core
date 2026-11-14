# F-001, F-008 and F-009 remediation

The finding numbers in this note refer to the October 14 report supplied for the November 12 remediation. They differ from the finding numbers in `audit/`.

F-007 is excluded from this remediation. Template signing retains the existing `SignedOperation` schema.

The release portal documents these changes in [Batch Price Array Validation](pages/batch-price-array-validation.html), [InstantOpen Gas Optimization](pages/instant-open-gas-optimization.html#atomic-completion), and [Cross-PartyB Liquidation Reserve Enforcement](pages/cross-partyb-liquidation-reserve.html#pending-mode).

## Batch Muon signatures (F-001)

The oracle-verified batch open and close paths require exactly one signed market price per submitted quote ID, before checking the Muon signature. Bound-mode batches still bypass Muon verification. This prevents moving an array element across the packed `quoteIds` / `prices` boundary. The Muon signing schema is unchanged.

## Atomic instant-open accounting (F-008)

Core records every quote whose pending bookkeeping was skipped. Atomic locking and opening require that quote to have been created in the same scope. Opening consumes its marker exactly once, and leaving the scope or disabling instant-open mode requires no unopened quotes. Otherwise the transaction reverts, including quote creation, fees, nonces and usage counters.

Both the native begin/end selectors and the historical setter sequence enforce completion. `setInstantOpenMode` now requires an active transaction scope; enabling a persistent shortcut across separate transactions is rejected. Ordinary batches may still leave normally tracked pending quotes.

`LibExecutionContext` now has linked public tracking helpers to keep the trading facets within the existing release-size budget. The deployment manifest and deployable-contract registry include this library. Core's PartyA, PartyBQuoteActions and PartyBBatchActions facets and the linked PartyBPositionActionsFacetImpl must use the new library. Replace the ExecutionContext facet as well. These are coordinated changes: do not mix the old and new atomic-open mutators or scope-closing code.

Confirm the persistent `callFromInstantLayer` and `instantOpenMode` flags are zero before upgrading. On a legacy version whose setters still write those fields, clear them before replacing those setters. New scopes reject legacy persistent execution flags, and the patched `setInstantOpenMode` requires an active scope.

The batch facet uses the compact `SymbolNotAllowedForPartyA()` and `DifferentPartyB()` errors in place of the previous strings for those two checks, preserving the release-size reserve.

## PartyB allocation mode (F-009)

An append-only `AccountStorage.Layout.partyBPendingLiquidationSettlements` counter tracks pending buckets per PartyB, including positive, zero and negative settlement amounts. It increments once when a bucket opens and decrements once during normal settlement or clearing-house takeover cleanup. Self-service activation and admin changes reject a mode change until every bucket involving that PartyB is cleared. Reapplying the current admin-configured mode remains allowed.

**Complete all existing PartyA liquidations and takeovers before upgrading.** The upgrade does not enumerate or backfill existing pending buckets, so they must not be carried across the upgrade. This supplements the hardening branch's existing requirement to drain in-flight liquidation workflows. Replace both mode-changing facets and both settlement/cleanup implementations together. No existing storage member or settlement tuple changes.

## Verification

The regressions exercise real TSS and gateway signatures for the packed-array attack, incomplete instant-open templates through both context protocols, and mode changes before and after normal settlement/takeover. Local tests do not establish deployed roles, installed selectors, or live Muon integration.

Solc 0.8.36 storage-layout output for a probe containing `AccountStorage.Layout` was compared against `0bd15adf`: all 31 existing members retain their slots, offsets and recursive types. The new counter is appended at relative slot 31.
