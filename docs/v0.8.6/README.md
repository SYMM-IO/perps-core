# Symmio Core v0.8.6 -- Change Index

Symmio v0.8.6 focuses on AccountLayer ownership/admin surfaces, Express Withdrawal design and operations, and a liquidation accounting fix. This index is intended as the entry point for auditors, operators, and integrators reviewing the v0.8.6 delta.

---

## Account & Ownership

### [AccountLayer Delegated Creation & Ownership Transfer](account-layer-ownership-delegation.md)

Auditor-focused note for the AccountLayer changes that add `ACCOUNT_CREATOR_ROLE`, role-gated SubAccount creation for another owner, direct SubAccount ownership transfer, and the affiliate ownership-transfer hook. Covers changed interfaces, storage impact, Virtual Account ownership resolution, hook ordering, revert semantics, security considerations, indexer events, and test coverage.

---

## Express Withdrawal

### [Express Withdrawal System Design](express-withdrawal-system-design.md)

Design document for the v0.8.6 Express Withdrawal system. Explains the user-facing withdrawal options, ExpressProvider pool model, credit line funding, liquidity priority, STANDARD/INSTANT/IMMEDIATE flows, acceleration, affiliate cap self-service, safety mechanisms, EIP-712 signatures, fee sponsorship, access control, bot responsibilities, contract interfaces, deployment, and known risks.

### [Express Provider Bot Operations Checklist](express-bot-operations-checklist.md)

Operational reference for the Express Provider bot. Covers state machines, timing windows, options API construction, providerData encoding, nonce management, signing requirements, processing and finalization, event monitoring, fee and sponsor handling, validator attestations, credit line decisions, multi-part withdrawals, risk lock/unlock flows, cancellation and suspension handling, error response, race conditions, pool monitoring, access control, and accounting invariants.

---

## Risk & Liquidation

### [Affiliate Shutdown Flow](affiliate-shutdown-flow.md)

Explains the frontend / affiliate shutdown flow: why it exists, how scheduling makes an affiliate close-only, how solvers close positions during the shutdown window, and how Clearing House can close remaining affiliate positions after the selected date.

### [Muon UPNL Validity Overrides](muon-upnl-validity-overrides.md)

Auditor and operator note for per-`MuonFunction` UPNL signature validity windows. Documents the single setter API, zero-clears semantics, fallback to global `setMuonConfig`, method groupings per Muon category, and effective validity resolution.

### [Liquidation Funding Snapshot Fix](liquidation-funding-snapshot-fix.md)

Auditor note for the PartyA liquidation funding snapshot fix. Documents the timestamp mismatch between liquidation prices and accumulated funding, the root cause in live funding calculations, the timestamp-aware funding helpers, the liquidation-path change to use the liquidation snapshot timestamp, expected behavior, regression coverage, affected files, and verification commands.

---

## Suggested Review Order

For protocol auditors:

1. [AccountLayer Delegated Creation & Ownership Transfer](account-layer-ownership-delegation.md)
2. [Affiliate Shutdown Flow](affiliate-shutdown-flow.md)
3. [Muon UPNL Validity Overrides](muon-upnl-validity-overrides.md)
4. [Liquidation Funding Snapshot Fix](liquidation-funding-snapshot-fix.md)
5. [Express Withdrawal System Design](express-withdrawal-system-design.md)
6. [Express Provider Bot Operations Checklist](express-bot-operations-checklist.md)

For bot and operations teams:

1. [Express Withdrawal System Design](express-withdrawal-system-design.md)
2. [Express Provider Bot Operations Checklist](express-bot-operations-checklist.md)
3. [Affiliate Shutdown Flow](affiliate-shutdown-flow.md)
4. [Muon UPNL Validity Overrides](muon-upnl-validity-overrides.md)
5. [Liquidation Funding Snapshot Fix](liquidation-funding-snapshot-fix.md)
6. [AccountLayer Delegated Creation & Ownership Transfer](account-layer-ownership-delegation.md)

---

## v0.8.6 Documentation Map

```text
docs/v0.8.6/
  README.md
  account-layer-ownership-delegation.md
  express-withdrawal-system-design.md
  express-bot-operations-checklist.md
  affiliate-shutdown-flow.md
  muon-upnl-validity-overrides.md
  liquidation-funding-snapshot-fix.md
```
