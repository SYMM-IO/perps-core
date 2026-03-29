# Symmio v0.8.5 — What's New

Symmio v0.8.5 is the biggest upgrade the protocol has seen. It touches almost everything — how accounts work, how withdrawals happen, how solvers manage capital, how positions are tracked, and how the entire system handles risk. This guide covers every change relevant to traders, frontend builders, and solver operators.

---

### Account Layer: One System for All Frontends

**The Old Mess**

Before v0.8.5, every frontend that wanted to integrate with Symmio had to deploy its own custom account contract. A trader on Frontend A had accounts in that contract. Wanting to try Frontend B? Set up accounts there too — totally separate, zero portability. And when the protocol improved, every frontend had to redeploy and migrate users manually. Each one did it differently. Some added NFT features on signup. Others had custom fee splits. It was chaos.

**The New Way**

Now there's one Account Layer — a single, standardized system that all frontends use. Traders create accounts under any frontend without that frontend deploying anything. Frontend upgrades? They happen for everyone instantly. No more waiting for each frontend to redeploy their own contracts.

**SubAccounts and Virtual Accounts in Plain English**

Think of an account like a folder system on a computer.

A **SubAccount** is the top-level folder — essentially the same thing as the account traders were using with the old MultiAccount contract. A trader can have multiple SubAccounts under the same frontend — one for conservative trades, one for aggressive bets, one for testing. Each SubAccount keeps its balance separate on the protocol. If one SubAccount gets liquidated, the others are untouched.

A **Virtual Account** is a sub-folder. It's where margin actually lives during trading. When a trader deposits, funds go to the SubAccount's balance. Before trading, some of that balance is moved into a Virtual Account — that's the trading bucket. When the position closes, the money auto-sweeps back to the parent SubAccount, ready for the next trade.

Unlike the old system where every new account meant deploying a new contract (expensive gas), creating a SubAccount or Virtual Account is now just a storage update — dramatically cheaper. Cheap enough that traders can realistically create a Virtual Account for every single position for maximum isolation.

Why do this? Position isolation. Separate Virtual Accounts for different positions or markets means a liquidation in one doesn't drain the others. Traders control how much risk each position can take.

**Four Ways to Organize**

When creating a SubAccount, the trader chooses an isolation type — how the protocol creates Virtual Accounts.

- **POSITION**: Every single trade gets its own Virtual Account. Maximum insurance. One liquidation only hurts that one position. Best for traders who want zero risk bleed between positions.
- **MARKET**: All BTC trades share one Virtual Account, all ETH trades share another. Markets stay completely isolated; directions mix. Simple and clean. Most traders use this one.
- **MARKET_DIRECTION**: Like MARKET, but even stricter — all BTC longs go to one Virtual Account, all BTC shorts to another. Separates directional bets.
- **CUSTOM**: Total freedom. No automatic Virtual Accounts. The trader manually creates them however they want. For sophisticated traders who know exactly what they need.

**For Frontend Builders**

The old system meant deploying and maintaining a custom account contract forever. Now frontends register as an affiliate with the protocol once and get approved. That's it. No more custom contracts, no more upgrades to manage. (For backward compatibility, a contract with a similar interface to the old MultiAccount is deployed — so migration is minimal.)

Fee distribution is built in. Frontends configure stakeholders at registration — a list of addresses and their percentage cuts. Example: 70% of trading fees to the operator, 20% to a referral partner, 10% to the protocol. Every time users trade, fees split automatically.

Hooks let frontends attach custom logic to account lifecycle events — NFT minting on signup, cashback, analytics — all without touching core protocol code.

---

### Withdraw System & Express Deposits

The withdrawal system has been completely rebuilt. The old system had two separate paths — the bridge contracts for instant withdrawals and the standard 12h cooldown flow. These are now unified into a single, cleaner system. Traders can queue multiple withdrawals at once (previously limited to one), and split a single withdrawal across multiple chains and receiver addresses.

On the instant withdrawal side specifically, there were two real problems:

**1. The API wasn't ideal.** The old bridge contract interface required frontends to handle more complexity on their side than they should have had to. That extra complexity occasionally led to integration issues across different frontends.

**2. Funding didn't scale.** Those instant withdraw contracts (bridge contracts) needed to hold real funds upfront to pay users immediately, then get reimbursed by Symmio after the cooldown. But who funds them? Either the frontend or Symmio had to put up a fixed pool of capital. That pool didn't grow with the user base — so as more users onboarded, the same limited pool got drained faster and faster. Eventually it would run dry, and users were back to waiting 12 hours.

**The new model fixes both.**

The contract API is now unified and clean — one withdrawal system, one interface, no frontend-side gymnastics.

For funding, the system now grows with the user base automatically. Here's how: the frontend sets a percentage — say 3%. After that, when a trader deposits 1000 USDC, 30 USDC (3%) is set aside to fund instant withdrawals, and 970 goes directly to Symmio. But the trader's balance shows the full 1000 USDC — the 30 that was set aside is credited as a virtual balance. The trader doesn't notice anything. Deposit 1000, see 1000, trade with 1000.

The magic is that as more users deposit, the instant withdrawal pool grows automatically. More users = more deposits = more funding for instant withdrawals. It scales with the platform instead of being a fixed pot that someone has to manually top up.

The risk of those funds sits with the frontend, not Symmio or the user.

From a user's perspective, when withdrawing there are up to three options: instant (~20 seconds) if the pool has enough, earliest-available (somewhere between now and 12h) based on projected pool inflows, or the standard 12-hour cooldown as a guaranteed fallback.

---

### Virtual Fund System: Trade Anywhere, Funds Everywhere

The old frustration: a trader has stablecoins on Ethereum but wants to trade on Arbitrum. So they bridge — waiting for confirmation, paying gas fees on both sides, watching the slip. Moving profits to a different chain later? More bridging. More waiting. More friction.

v0.8.5 changes this. Traders can deposit on one chain and trade on another without touching a bridge. The frontend's service handles the cross-chain logistics behind the scenes — deposit on Ethereum, balance shows up on Arbitrum within seconds, start trading. No wrapped tokens, no slow confirmations.

When withdrawing, the same system works in reverse — but now with options across chains. Withdrawing 1000 USDC might offer 900 on Arbitrum and 100 on Base, or the full 1000 on BSC, depending on where liquidity is available. The trader picks the split that works, and it all happens in one withdrawal request. Ideally funds arrive wherever wanted — and a well-run service will rebalance its liquidity across chains to offer better options over time.

The end result: traders stop thinking about which chain their money lives on. They think about where to trade, and where to receive profits.

---

### Cross Mode for Solvers

**The Old Problem: Isolated Allocations**

Before v0.8.5, a solver's balance was isolated per trader. To open positions with multiple traders, the solver had to allocate and lock a separate balance for each one. Each allocation was managed independently and could only cover positions with that specific trader.

This created a real inefficiency. Because each allocation was evaluated on its own, a solver could be liquidated on positions with one trader simply because that particular allocation ran thin — even if, across all positions combined, the solver was perfectly solvent. The solver's overall health didn't matter; only the per-trader slice did.

In practice, this meant solvers had to over-allocate. They'd keep extra buffer in each per-trader bucket just in case, tying up capital that could have been used productively elsewhere. And they had to constantly monitor and rebalance dozens or hundreds of separate allocations.

**The New Experience: One Pool, One Evaluation**

Cross mode lets a solver pool all their capital into a single balance that covers positions across all traders. Instead of maintaining separate allocations per trader, the solver funds one shared bucket. Solvency is evaluated against the total — all positions, all traders, one number.

If positions with one trader cause a loss, the solver's entire pool absorbs it. If positions with another trader are profitable, that offsets it. Profits and losses net across the full book. This is how traditional market makers operate, and now Symmio solvers can do the same.

The practical upside: less over-allocation (no more buffers in every per-trader bucket), fewer false liquidations (judged on aggregate health), and simpler operations (one pool to manage instead of hundreds).

For users, this means better-capitalized solvers who are less likely to get unfairly liquidated. Trades are backed by the solver's total capital, not just the slice they happened to allocate to a specific trader.

**The Tradeoff: More Power, More Trust**

There's a catch: cross mode is more dangerous than isolated mode.

In the old system, if a solver behaved badly, they could only damage one user's account. In cross mode, that same malicious solver could manipulate prices across multiple accounts, siphoning funds from user A to cover losses from user B. One bad actor with a shared pool can hurt everyone.

For this reason, cross mode is restricted to trusted solvers. Only proven solvers are activated, typically by the Symmio team. And there's continuous off-chain monitoring — 24/7 surveillance watching for unusual activity, late liquidations, or price manipulation. If a solver gets caught misbehaving, Symmio can suspend them instantly.

These monitoring systems also enforce stricter solvency requirements than the on-chain minimum. Cross-mode solvers are expected to maintain over-collateralization — something like 120% solvency at all times. If they drop below that threshold, soft liquidation penalties kick in before things get critical. This buffer protects users even further: by the time on-chain solvency would matter, the off-chain system has already intervened.

This is the trade: better capital efficiency and lower liquidation risk, but it requires trusting Symmio to run the off-chain guardrails.

**What Changes (and What Doesn't)**

For traders, the changes are mostly invisible. They still open and close positions the same way. The solver just handles capital differently behind the scenes. What improves is reliability.

For developers and frontends:

- **Settlement is now one-to-many.** The old settlement handled one user at a time. The new unified settlement handles one solver across multiple users in a single transaction.
- **Force close is now a 3-step flow.** Initialize (lock in the close price), settle (reallocate funds if needed), finalize (execute the close). Each step can be its own transaction.
- **New liquidation step: settleUpnl.** Because a cross-mode solver's actual cash balance can be low (most of their value may be unrealized profit from positions with other traders), a new step was added to the trader liquidation flow. Before settling a liquidation, liquidators may need to call `settlePartyBUpnlForLiquidation` to realize the solver's unrealized profits from positions with other healthy traders — converting paper profit into actual balance so the settlement has real funds to work with.

---

### Instant Layer

Symmio already had instant trading before v0.8.5 — and it already felt like a CEX. The old MultiAccount contract had a `delegateAccess` feature where traders would grant a solver permission to call specific functions on their behalf. No wallet popups after the initial setup. It worked, but the security model had real limitations:

- **Full trust required.** The trader was handing the solver indefinite, unrestricted access to the delegated functions. A solver would never intentionally abuse this, but if their infrastructure got compromised, the trader's account was exposed.
- **No time limits.** Once delegated, that permission lived forever until manually revoked (with a cooldown).
- **No parameter restrictions.** If `sendQuote` was delegated, the solver could send any quote with any parameters. There was no way to say "only this specific trade."
- **No session scoping.** There was no concept of a temporary key that expires when the browser closes.

The Instant Layer replaces delegateAccess with a more secure and flexible system built on signed operations.

**Signed Operations — Parameter-Level Control**

Instead of granting blanket permission to call a function, the trader now signs the exact operation they want executed — function, parameters, everything. The solver can only execute that specific operation with those specific values. Change a single parameter and the signature is invalid. Each operation also has a deadline (it expires) and replay protection (it can only be used once).

This is the core difference: the old system was "I trust this solver to call this function however they want." The new system is "I've approved this exact operation and nothing else."

**Session Keys**

When a trader visits a Symmio trading platform, the site generates a temporary key in the browser. The trader approves it once with their wallet by signing a delegation. From that moment, all trades are signed by this session key — no more wallet popups. The key automatically expires after a configurable period (e.g., daily), and it's gone when the tab closes.

The old delegateAccess couldn't do this because it was a static on-chain permission flag — no signatures, no expiry, no browser-scoped keys.

Since session keys are just cryptographic keys with a signed delegation, frontends can get creative with how they're used. For example, a frontend could let traders scan a QR code to transfer their session key to a phone — and continue trading from there without any wallet app installed. The key is temporary and scoped, so even on a phone it carries minimal risk.

**Delegated Permissions — With Expiry**

Traders can still grant ongoing permission for specific functions (like the old system), but now with an expiry timestamp. Grant a stop-loss bot permission to call `requestToClosePosition` until tomorrow — after that, the permission dies automatically. No need to manually revoke.

**Atomic Multi-Step Execution**

Opening a position is a multi-step flow: send quote, solver locks it, solver opens it. Previously, solvers could chain these using a `sequenceCall` method on the PartyB contract — but that was limited to solver-side operations only and was a rough implementation. The Instant Layer replaces this with proper templates that work for both sides. Both the trader and solver sign their respective parts, and the Instant Layer executes the entire sequence atomically in one transaction. The quote ID from the first step automatically flows into the next steps via placeholder replacement.

**What this means in practice:**

For traders: fewer wallet popups, time-limited permissions, and the confidence that a delegated party can only do exactly what was signed for.

For frontend builders: session keys and expiring delegations provide a safer permission model.

For solvers: atomic execution means no more race conditions between steps. Sign once, execute with the user's signature, everything settles in one block.

---

### Oracle-Less Trading (Binding)

Normally, every quote submission and quote lock requires a Muon oracle signature — a cryptographic proof of the trader's current UPNL and the market price. The solver has to request this signature from the oracle network before it can act on the quote. That round-trip to the oracle adds latency to every single trade.

v0.8.5 introduces **binding**: a trader can bind exclusively to one solver, and from that point on, oracle signature verification is skipped entirely for both sides. The solver can lock quotes immediately without waiting for oracle responses. The UPNL values passed in the transactions are accepted as-is.

Why is this safe? Because when bound, the trader can only trade with that one solver. There's no second counterparty who could be harmed by inaccurate values — the trust relationship is fully contained between the trader and their bound solver. If the solver passes bad values, it only affects the two of them.

**Prerequisites for binding:**
- The solver must be marked as "bindable" by the protocol — not all solvers qualify
- The trader must have zero pending quotes
- All existing open positions must already be with that solver (or there are none)

**Unbinding** has a cooldown: the trader requests it, waits a configurable period, then finalizes. The solver can complete the unbind immediately if they agree, but the trader has to wait. This prevents a trader from quickly unbinding to dodge obligations.

**Instant Action Mode** builds on top of binding. Once bound, the trader can activate instant action mode, which blocks them from submitting transactions directly to the protocol — they can only trade through the Instant Layer. This guarantees the solver won't face race conditions from conflicting on-chain transactions while processing the trader's off-chain orders. Deactivating instant mode also requires a cooldown.

The Instant Layer works independently of binding — session keys, delegated permissions, and batched execution work without being bound to anyone. But binding + instant action mode is where it shines: the solver knows the trader won't submit competing transactions, oracle checks are out of the way, and everything executes atomically. It's the primary use case these features were designed for.

---

### Accumulated Funding Rate

The old funding system required solvers to manually charge funding on every single open position at each epoch boundary (every 8 hours). Hundreds of positions meant hundreds of transactions in a narrow window. Miss the deadline? Wait another 8 hours.

The new system accumulates funding automatically per market. Solvers no longer need to touch individual positions — they set a rate, and the protocol tracks what each position owes based on how long it's been open. Epoch durations are now flexible too, so solvers can adjust frequency without breaking anything.

**For solvers:** dramatically less operational overhead. No more batching hundreds of funding transactions under time pressure. Set the rate, the protocol does the rest.

**For traders:** more accurate and transparent funding, no ambiguity about what they owe. Funding debts are included in the UPNL calculation and settled when positions close or whenever the solver decides to settle them.

---

### Aggregated Positions

Calculating someone's unrealized PnL used to require scanning through every single open position. With thousands of positions across dozens of markets, that's expensive — whether it's the oracle computing UPNL for a signature, a liquidator checking solvency, or any application that needs to know an account's health.

The new system maintains running totals per market: total size, total notional value, and average entry price. Funding debt is aggregated the same way — instead of summing up what each individual position owes in funding, the system tracks a weighted total per market that rolls up into the UPNL calculation directly. Both position PnL and funding debt are now computed from market-level summaries instead of position-level iteration.

This applies to both sides — traders (partyA) and solvers (partyB), including cross-mode solvers (global aggregates across all traders) and isolated solvers (per-trader aggregates). Anyone computing UPNL — the oracle network, liquidators, frontends, analytics tools — benefits from this. Faster UPNL calculations mean faster solvency checks, faster liquidations, and faster everything that depends on knowing how much an account is worth.

---

### Trading Fees: Full Control, No More Symbol Duplication

Before v0.8.5, trading fees were baked into symbol definitions — and only Symmio could add symbols. If different frontends on the same chain wanted different fee rates, they each needed their own duplicate symbols. Per-user fees? Not possible at all. Frontends had zero autonomy over their own fee structure.

Now fees are controlled independently of symbols. Frontends (affiliates) can set both **open fees** and **close fees** at four priority levels:

1. **Per user + per symbol** — "Give user 0xABC a 5bp fee on ETH specifically"
2. **Per user default** — "Give user 0xABC a 10bp fee on everything"
3. **Per symbol for the affiliate** — "My platform charges 15bp on BTC"
4. **Affiliate default** — "My platform charges 20bp on everything"

If none of these are set, the system falls back to the symbol's default trading fee (set by Symmio). The resolution happens automatically — VIP users get their rate, everyone else cascades down to whatever tier matches.

Frontends set these by calling `setAffiliateFee` (for per-market and default rates) or `setAffiliateFeeForUser` (for user-specific rates). Both support batch operations — set fees for multiple users or symbols in one transaction. The affiliate can call these directly, or have someone with the affiliate manager role do it.

**Close fees are new.** Before v0.8.5, only open fees existed. Now fees can be charged when positions close too. Both open and close fees are set independently per tier, and both must respect a protocol-wide minimum (`minAffiliateFee`) — affiliates can't race fees to zero. If a frontend has a legitimate reason to go below the minimum (e.g., a promotional campaign or a specific business model), they can request an exception from Symmio with an explanation.

**Fee distribution** is handled through the Account Layer. When a frontend registers as an affiliate, it configures stakeholders — a list of addresses and their percentage shares (e.g., 70% to the frontend operator, 20% to a referral partner, 10% to the protocol). Fees accumulate in a collector address, and any stakeholder can trigger a claim that automatically splits and distributes. Changing the stakeholder split requires a two-step process (request + approval) to prevent fee hijacking.

---

### Symbol Types

Before v0.8.5, there was no symbol-level access control for solvers. Any registered solver could trade any symbol. If Symmio added a risky new market (say, a low-cap vibe token), every solver was automatically exposed to it whether they wanted to be or not.

v0.8.5 introduces a symbol whitelisting system with two dimensions:

**Symbol types** assign each symbol a category number (e.g., 1 = blue-chip crypto, 2 = forex, 3 = exotics). Solvers can whitelist an entire type — when a new symbol is added with type 1, every solver that has whitelisted type 1 can immediately trade it without any additional configuration.

**Per-symbol whitelisting** lets solvers whitelist or blacklist individual symbols for finer control. A solver might whitelist type 1 broadly but blacklist a specific symbol within that type. Blacklist always takes precedence.

Both dimensions coexist. Symbols without an assigned type default to type 0. A solver that only whitelists type 1 cannot trade type-0 symbols unless those are individually whitelisted.

**How it affects traders:** when a trader has open positions with multiple solvers, the protocol checks that ALL connected solvers support the symbol before allowing a new position. If a trader has positions with Solver A and Solver B, and Solver B hasn't whitelisted that symbol or its type, the trader can't open a new position on it with Solver A either. This prevents a situation where a trader opens positions on symbols that some of their connected solvers can't price or settle.

---

### Custom Quote Data

Sometimes frontends or solvers need to attach metadata to a trade — an order ID from an off-chain system, routing hints, anything that links the on-chain transaction back to an internal flow.

Arbitrary data can now be passed when sending a quote. That data stays attached to the position for its entire lifecycle: open, close, everything in between. Perfect for instant trading setups where on-chain trades need to be stitched back to off-chain orders without a separate database lookup.

---

### Batch Position Management

Previously, opening or closing each position was a separate transaction. Each one required its own oracle signature (with its own UPNL and price data), its own solvency check, and its own nonce increment. If a solver needed to respond to 10 quotes from the same trader, that was 10 oracle requests, 10 transactions, 10 nonce bumps.

`openPositions` and `fillCloseRequests` let a solver open or close multiple positions with the same trader in a single transaction. The oracle signature covers all the quotes at once — it contains an array of quote IDs and an array of prices, but only one pair of UPNL values for the solver and trader. Verification happens once, the nonce increments once, and solvency is checked once against the cumulative state change across all positions in the batch.

All quotes in a batch must belong to the same trader and the same solver. Different symbols within the batch are fine. Partial fills still work — each position can be partially filled independently.

In bound mode, oracle verification and solvency checks are skipped entirely, so batch becomes purely a loop optimization — multiple positions processed in one transaction with one nonce increment.

The prime use case is bot traders opening many positions in rapid succession — the solver can respond to all of them in one shot instead of handling each individually. It's also useful when a regular trader wants to close a bunch of positions at once (or all of them) — the solver can fill all those close requests in a single transaction.

---

### ClearingHouse

Think of the ClearingHouse as the emergency protocol for the protocol. It's a privileged operator that steps in when the normal, automated liquidation system hits scenarios that require human judgment rather than math.

**The Normal System Works Fine — Until It Doesn't**

In the everyday case, liquidations are decentralized. Any qualified liquidator can step in when a trader or solver goes insolvent, close their positions, and settle balances. This works great for most situations. But two edge cases exist where automation alone creates worse problems than it solves.

**The First Problem: Cross-Mode Solver Insolvency**

Some solvers pool all their funds together across all their traders. When that solver becomes insolvent, thousands of positions across hundreds of traders suddenly depend on unwinding a single shared pool.

An automated liquidator can't handle this fairly: dividing a shrinking pool across many traders requires judgment. There's no objective rule that prevents the liquidator from favoring certain traders or gaming the distribution. A trusted operator needs to make these calls.

**The Second Problem: Stuck Liquidations**

Occasionally a trader's normal liquidation gets stuck. Maybe the original liquidator abandoned it. Maybe there's a dispute. Maybe the on-chain state got corrupted. The ClearingHouse can take over, reset the state, and finish the job.

**What This Means**

The tradeoff is real: yes, the ClearingHouse is centralized. One trusted operator has power here. But the alternative — letting automated systems handle cross-mode insolvency — would create worse outcomes. It's like a circuit breaker: it rarely fires, but when it does, a human in the loop makes the hard calls about fairness.

For traders: fund distribution happens in explicit, on-chain steps that anyone can audit. The ClearingHouse operator can't just vanish with funds — every dollar is accounted for.

For solvers: running a cross-mode operation means accepting that an insolvency event requires a trusted third party to unwind fairly. It's the price of capital efficiency.

---

### Soft Liquidation: Graduated Warnings Instead of the Guillotine

Previously, solver liquidation meant total wipeout. If a solver's balance dipped below the danger threshold — every position closed instantly, every user disrupted, hundreds of thousands in volume vanishing in a single block. All or nothing.

Soft Liquidation introduces graduated warning stages that give solvers time to top up funds before disaster strikes. Think of it like a bank calling at three different points before freezing an account.

As a solver's balance approaches the critical zone, configurable penalty tiers kick in. Maybe the first warning comes at $350 (balance locked), alerting the solver to take action. If they still don't respond by $300, a penalty is charged — say, $50 deducted and sent to the protocol. By $200, that's when full hard liquidation triggers.

The key insight: these thresholds and penalties are configurable by the protocol. Well-established solvers might get lenient terms. New entrants might face stricter monitoring.

**Why users should care:** Solvers are less likely to disappear overnight because of a 24-hour funding delay or a temporary market shock. That stability translates to consistent fills and fewer surprise liquidations disrupting portfolios.

---

### ADL Close: When Solvers Need to Reduce Risk (Fast)

Auto-Deleveraging (ADL) is the controlled circuit-breaker every solver has been asking for. It lets solvers forcibly close positions to manage risk exposure — without needing emergency mode, without needing admin approval.

Sometimes the market moves in a way that makes a solver's overall risk exposure unacceptable. They need to de-risk now. The old system forced solvers to either trigger a full emergency closure (which nukes everything), wait for the trader to request closes (no control over timing), or watch positions blow up while waiting for admin action.

ADL bypasses all that. The solver decides which positions to close and at what price. Execute. Done.

But there's a catch — and it's intentional.

---

### Pledge Collateral: Skin in the Game for ADL

Before using ADL, solvers must deposit separate collateral as a guarantee of good behavior. This isn't trading balance. It's a reserve that says: "I'm serious about using this responsibly."

If a solver abuses ADL — closing positions at wildly unfair prices that hurt users — their pledge gets slashed by the protocol. It's skin in the game. It aligns incentives with fairness.

Withdrawing pledge takes two steps: the solver requests a withdrawal, then an admin approves it. No auto-release. This prevents solvers from yanking their guarantee mid-emergency.

Here's the ecosystem effect: Solvers who pledge heavily signal competence and fairness. Users naturally gravitate toward solvers with skin in the game. Bad actors who try to ADL-close at unfair prices get financially punished and priced out.

Together, soft liquidation + ADL + pledge form a three-layer risk framework: graduated penalties to avoid unnecessary wipeouts, surgical de-risking tools for solvers, and collateral guarantees to prevent abuse.

---

### Liquidation Insurance: Keeping Liquidation Costs Fair

When a trader gets liquidated, their account is closed out and remaining collateral is distributed. If they had multiple open positions and plenty of locked-up fees, there's a pot of money left over — and that pot can be huge. Without guardrails, liquidators would compete aggressively (bidding up gas fees) to grab that payout, driving costs up for everyone.

Symmio caps how much profit a liquidator can earn per position. Any excess above that cap flows into an insurance vault instead of going to the liquidator's pocket. This removes the incentive to front-run other liquidators with high gas bids, keeping liquidation costs reasonable. And the protocol builds up a reserve fund from these excess payouts — which can then be used to cover losses from liquidations that turn out worse than expected.

---

### Liquidation Escrow: Stopping the Drain-and-Disappear

Here's a scary scenario for solvers: a trader with pending orders could drain their account by creating many orders with high trading fees, letting their fees accumulate and hoping to recover them later. If that account gets liquidated at a severe deficit, those pending orders get cancelled and their fees refund. Without protection, the trader could recover those exact funds at settlement — even though they just bankrupted a solver.

Symmio prevents this with liquidation escrow. When a liquidation is severe enough that solvers absorb losses, any pending fee refunds don't go back to the trader. Instead, they're held in escrow and the protocol distributes them to the solvers who took the hit.

---

### Cross-Mode Settlement During Liquidation

A cross-margin solver might look healthy on paper. They have, say, $200 in actual cash but $500 in unrealized profit across positions with healthy traders. That profit counts toward their solvency — they're net positive.

But liquidation settlement needs real money now, not future profit. For a cross-margin solver with low actual cash but high unrealized gains, Symmio can realize those gains first by settling positions with other healthy traders, converting paper profit into actual balance. Only then does settlement happen.

If the solver's gains are locked up with another trader who's also being liquidated, the system waits until that liquidation clears. If there's no way to unlock enough cash, the ClearingHouse steps in.

---

### Oracle Key Management

The oracle network signs critical data — profit/loss, liquidation prices, funding fees — before it hits the blockchain. Previously, Symmio hardcoded a single oracle key into the protocol. If that key was compromised, the entire system was at risk. Rotating it meant downtime.

Now, Symmio maintains keys in a separate contract. A new key can be added while the old one is still active — traders don't skip a beat. More importantly, keys are scoped to specific operations. A key authorized to sign trade data cannot sign liquidation data. A key for funding rate charges cannot approve settlements. This compartmentalization means if one key is accidentally exposed, only a subset of operations are at risk, and just that key gets rotated without touching the others.

---

### Hook System: Building Features Without Forking the Protocol

Every time a position opens, closes, or gets cancelled, Symmio now fires a notification to the affiliate's registered hook contract. Hooks are tied to affiliates, so each frontend gets its own pipeline into the protocol's event stream.

Why this matters: frontends own their user experience without modifying core code. Want to offer cashback on trades? The hook sees the fee amount and can distribute tokens instantly. Running a loyalty program? The hook gets real-time trade data and can mint points when users hit volume milestones. Need to track user activity on-chain? The hook records every transaction.

The protocol protects against a critical risk: a malicious hook cannot impersonate the trader. Before calling the hook, the protocol clears the signer identifier, so any attempt to re-enter and steal funds will fail.

---

### Role Admin System: Let Teams Own Their Domain

Governance is now delegated. Instead of one admin wallet controlling every permission change, specialized teams can be appointed.

Before, the protocol admin was a bottleneck: every liquidator added, every configuration change went through that one account. Now, the main admin can appoint a liquidation operations team to manage liquidator permissions, a config team to manage settings, a fee team to manage fee parameters — each group granted authority over only their domain.

A liquidation ops team cannot modify fee parameters; a fee team cannot add liquidators. Centralized control is maintained through the owner, but day-to-day overhead shifts to teams that understand their area.

---

### Two-Step Ownership: No More Typos, No More Lost Control

Transfer ownership in two steps instead of one.

Previously, calling `transferOwnership(newAddress)` with a wrong address — a typo, a contract that can't interact — meant ownership was gone forever.

Now the current owner proposes a transfer, and the new owner must explicitly accept it. The current owner sets a pending owner but doesn't change who actually controls the protocol. The new owner then confirms to take the keys. If the address was wrong, the current owner can call the transfer again with a corrected address — no permanent damage.
