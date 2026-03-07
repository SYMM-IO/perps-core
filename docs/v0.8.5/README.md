# Symmio Core v0.8.5 — Upgrade Guide

Symmio v0.8.5 is a structural overhaul of the protocol. It introduces a standalone account management diamond, replaces the withdrawal system entirely, adds cross-margin support for solvers (PartyBs), and redesigns funding rate and position tracking from per-quote granularity to per-symbol aggregation. This guide covers every change relevant to solver operators, frontend integrators, and auditors.

---

## Account & Fund Management

### [Account Layer](account-layer.md)

A standalone Diamond proxy (EIP-2535) that replaces the per-frontend MultiAccount contracts. Users create SubAccounts tied to an affiliate and a Symmio core, then trade through VirtualAccounts that provide position isolation at four levels: per-trade, per-market, per-market-direction, or fully custom. The system handles affiliate registration, fee distribution to stakeholders, express deposits that split funds between real and virtual providers, and on-chain hooks for custom logic like NFT minting or loyalty points.

### [Withdraw System](withdraw-system.md)

Complete replacement of the old single-step withdrawal. Users can now split a withdrawal across multiple chains and providers in a single atomic request. Express providers front the funds immediately for a fee, virtual providers deliver cross-chain, and both can be combined. Includes cooldown management, speed-up approvals for whitelisted users, cancellation flows with blackout windows, and admin force-cancel capabilities.

### [Virtual Fund System](virtual-funds.md)

Enables cross-chain deposits and withdrawals without bridging. A trusted virtual provider credits a user's balance on the target chain via `virtualDepositFor`, while the actual collateral stays on the source chain. When withdrawing, the provider pays out on the user's preferred chain. Deeply integrated with the new withdraw system — virtual providers implement lifecycle callbacks for acceptance, completion, and cancellation.

### [External Transfer](external-transfer.md)

Lets users move funds to any trusted target contract through an authorized relayer -- not just other Symmio diamonds, but any whitelisted external contract. Symmio trusts the relayer to handle funds at the target, with admin roles to revoke access or confiscate funds if fraud is detected. Also supports virtual external transfers for balance-only movements where no actual token transfer is needed.

### [Express Deposit & Withdrawal](express-deposit.md)

Lets affiliates route a configurable percentage of user deposits into an express provider contract, building a liquidity pool that funds faster withdrawals. Users get up to three options: instant (~20 seconds) when liquidity is available, earliest-available (somewhere between now and 12 hours) based on projected liquidity inflows, or the standard 12-hour cooldown as a guaranteed fallback. The system coordinates an Express Contract (per-chain liquidity management with bucket-based scheduling), a Virtual Contract (per-frontend deposit-funded pool), and an off-chain bot for risk assessment and processing.

### [Safe Deallocate](safe-deallocate.md)

Prevents a front-running attack where a user deallocates funds while a solver's batched transaction (sendQuote + lockQuote + openPosition) is still in flight. Muon now provides a `pendingBalance` value representing off-chain committed funds, and the contract ensures available balance covers both pending operations and the deallocation.

---

## Trading Execution

### [Cross Mode for Solvers](cross-party-b.md)

Solvers can now pool all their collateral into a single cross-margin bucket instead of fragmenting it across individual PartyA counterparties. This means a solver won't get liquidated on one user just because that particular allocation ran thin — solvency is evaluated against the total pool. Has deep implications for nonce handling (zero-nonce signatures for parallel operations), settlement (unified settlement across multiple PartyAs), force close (3-step flow with optional settlement), and liquidation (handled by the ClearingHouse instead of decentralized liquidators).

### [Oracle-Less Trading](oracle-less-trading.md)

When a PartyA trades exclusively with a single PartyB, Muon oracle signatures become unnecessary overhead. PartyA can bind to that PartyB, and from that point all signature checks are bypassed. Unbinding requires a cooldown period to prevent abuse. Designed for low-latency trading environments where the solver is the sole trusted counterparty.

### [Batch Position Management](batch-positions.md)

Opens or closes multiple positions in a single transaction with one Muon signature instead of one per position. Reduces gas costs and response latency for solvers processing a backlog of requests.

### [Instant Layer Overview](instant-layer-overview.md)

Replaces the old broad `delegateAccess` with a safer model: users sign a specific operation (EIP-712) and hand it to PartyB, who submits both signatures together. Supports delegation to session keys (e.g., a browser-generated keypair rotated daily), template operations that chain results across steps (sendQuote → lockQuote → openPosition in one tx), and flexible replay protection with salt-only or sequential nonce modes.

### [Instant Layer PartyB Integration](instant-layer-partyb-integration.md)

Solver-specific integration guide covering how PartyBs set up their operator, register with the Instant Layer, handle user signatures, and execute templated workflows.

---

## Risk & Liquidation

### [ClearingHouse](clearing-house.md)

Handles the two liquidation scenarios that decentralized liquidators can't: cross-mode PartyB insolvency (where thousands of positions across many users need coordinated unwinding) and stuck PartyA liquidations (where the on-chain state is too corrupted for the normal dispute resolver to fix). Operates as a multi-step lifecycle — deallocate funds from involved parties, close positions at ClearingHouse-specified prices, distribute proceeds, and settle. Also handles the edge case where both a PartyA and its cross-mode PartyB are liquidated simultaneously via auto-takeover.

### [Soft Liquidation](soft-liquidation.md)

A tiered warning system before hard liquidation. As a PartyB's balance approaches the danger zone, the ClearingHouse can issue on-chain penalties at configurable thresholds — giving the solver time to top up funds instead of immediately closing all positions and disrupting every user on every frontend.

### [ADL Close](adl-close.md)

Allows solvers to unilaterally close positions to reduce risk exposure without needing emergency mode or delisted symbols. No solvency checks are enforced on PartyB during ADL, which means it works even when the solver is underwater. To prevent abuse, PartyBs must deposit assurance collateral that can be slashed if ADL is misused. Emits mock events that mirror the normal close flow so indexers and UIs don't need special handling.

### [Liquidation Insurance Vault](liquidation-insurance.md)

Caps how much liquidators can earn per position and redirects the excess into a protocol vault. That vault is reserved to reimburse PartyBs who suffer losses from late liquidations — situations where a position should have been liquidated earlier but wasn't.

---

## Funding & Positions

### [Accumulated Funding Rate](accumulated-funding.md)

Replaces the old system where solvers had to process funding for every individual position at each epoch. Instead, funding rates are tracked as weighted averages at the symbol level. When a solver sets a new rate, it blends into the running average — no need to touch individual positions. Rates are pre-multiplied by market price at storage time to eliminate price lookups during calculation. Supports dynamic epoch duration changes with automatic rate scaling.

### [Aggregated Positions](aggregated-positions.md)

Maintains running totals of position size and notional value per (party, symbol, positionType) combination, so UPNL calculations only need to iterate over active symbols instead of individual quotes. For a solver with 5,000 positions across 50 symbols, this turns solvency checks from O(5000) to O(50). Also tracks aggregate funding debt for the same efficiency gain.

---

## Fees & Symbols

### [Affiliate Fees](affiliate-fees.md)

Affiliates can now set custom open and close fees at four priority levels: per user+symbol, per user default, per symbol, or affiliate-wide default. The close fee is factored into solvency checks after position closure. Also adds `fillCloseRequestToLiquidation` — when a normal close would push PartyA into insolvency, this calculates the maximum partial close that brings them exactly to the liquidation threshold.

### [Symbol Types](symbol-types.md)

Groups symbols into categories (e.g., Binance pairs vs. lowcap vibe markets) and lets PartyBs whitelist entire categories rather than individual symbols. When new symbols are added to a category, all whitelisted PartyBs can immediately trade them without additional configuration.

### [Custom Quote Data](custom-quote-data.md)

Allows attaching arbitrary bytes to a quote at creation time via `sendQuoteWithAffiliateAndData`. The data persists through the entire quote lifecycle and is included in events, enabling off-chain systems to track things like temp quote IDs from instant mode flows.

---

## Infrastructure

### [Muon Signature Keys](muon-keys.md)

Moves from a single hardcoded Muon public key and gateway signer to an external `MuonSignatureVerifier` contract that manages multiple keys. Enables key rotation without redeploying the diamond, supports multiple independent Muon nodes for fault tolerance, and decouples key management access control from the core protocol.

### [Hook System](hook-system.md)

Every position open, close, cancel, and funding charge now fires an on-chain hook notification. Affiliates register hook contracts implementing `ISymmioHook` to execute custom logic — reward tracking, volume analytics, cashback programs — all with fresh on-chain data. The signer context is cleared before hook invocation to prevent privilege escalation.

### [Role Admin System](role-admin-system.md)

Adds delegated role management on top of the existing RBAC. Previously, only a single admin could grant and revoke roles. Now the owner appoints default admins, who can delegate management of specific roles to dedicated addresses via `addRoleAdmin` / `removeRoleAdmin`. Per-role admins can grant and revoke their assigned role without needing owner or default admin transactions. Delegation is one level deep -- per-role admins cannot sub-delegate.

### [Two-Step Ownership Transfer](two-step-ownership.md)

The new owner must explicitly call `acceptOwnership` after the current owner calls `transferOwnership`. Prevents accidental ownership loss from address typos.

### [Event Changelog](event-changelog.md)

Complete changelog of every event change from v0.8.4 to v0.8.5 — removed backward-compatible overloads, changed signatures, new events on existing facets, events from new facets (ClearingHouse, Binding, Pledge, ExternalTransfer, Withdraw), and all AccountLayer diamond events. Includes migration checklists for subgraph developers, hedger integrators, and frontend teams.

---

## Upgrade & Migration

### [Migration Process](migration.md)

Backfills the new aggregated position structures and master account buckets from existing v0.8.4 data. Run during a global pause after the diamond cut — migrates quote-level data into symbol-level aggregates and sums per-PartyA balances into the cross-margin bucket.

### [Migration Script Usage](../../scripts/docs/migration-script-usage.md)

Practical guide for running the migration scripts against a live deployment.

### [Update And Migration Path](../../scripts/docs/update-and-migration-path.md)

Operational runbook for local rehearsal (v0.8.4 state seed -> v0.8.5 upgrade -> migration phase), including worktree setup and output locations.

### [Upgrade Output Verification](../../scripts/docs/upgrade-output-verification.md)

How to read generated reports, verify invariant checks, and identify selector-level `diamondCut` add/replace/remove changes.

### [Setup Task](setup-task.md)

Post-migration configuration tasks for initializing v0.8.5 parameters and verifying the upgrade.
