# SYMMIO Perps Core

Smart contracts for SYMMIO's intent-based perpetual derivatives protocol.

[Website](https://www.symm.io/) · [Protocol docs](https://docs.symm.io/) · [Technical docs](https://docs.symm.io/protocol-architecture/technical-documentation) · [Deployments](https://docs.symm.io/api-endpoints-and-deployments/symmio-perps-deployments) · [Explorer](https://symmscan.com/)

## What is SYMMIO?

SYMMIO is shared infrastructure for permissionless derivatives markets. Traders submit intents through independent exchanges built on SYMMIO, and solvers compete to take the other side of each trade. Solvers lock collateral, while the protocol enforces positions, funding, liquidations, and settlement on-chain.

This hybrid design keeps quoting and trade discovery off-chain for speed, while collateral and settlement remain verifiable on-chain. It does not depend on a shared AMM liquidity pool or a central order book.

SYMMIO itself does not operate a trading frontend. Traders access the protocol through [independent frontend builders](https://www.symm.io/frontends); exchanges and market makers integrate with the protocol as infrastructure.

## What is in this repository?

`perps-core` contains the Solidity contracts and operator tooling for SYMMIO's perpetuals system:

- **Core protocol** — collateral, bilateral positions, funding, settlement, liquidations, and withdrawals.
- **AccountLayer** — sub-accounts, delegated access, affiliates, and account-level margin.
- **InstantLayer** — authorized batched execution for low-latency trading flows.
- **Express Withdrawal Layer** — independently deployed, credit-backed fast withdrawals.
- **gaslessLayer** contains the upgradeable Gasless Layer, deterministic GaslessWallet contracts, fee routing, and relay tooling.
- **Deployment application** — reviewed deployment, upgrade, verification, and handover workflows.

The contracts use the [EIP-2535 Diamond standard](https://eips.ethereum.org/EIPS/eip-2535). Detailed contract and module documentation belongs in the technical docs and release notes, not in this overview.

## Versions

| Version                | Status                | Code and release notes                                                                                                       |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **v0.8.6**             | Current release line  | [`version_0.8.6`](https://github.com/SYMM-IO/perps-core/tree/version_0.8.6) · [v0.8.6 release notes](docs/v0.8.6/index.html) |
| **v0.8.5**             | Previous release line | [`version_0.8.5`](https://github.com/SYMM-IO/perps-core/tree/version_0.8.5) · [v0.8.5 release notes](docs/v0.8.5/index.html) |
| **v0.8.4 and earlier** | Historical releases   | [Git tags](https://github.com/SYMM-IO/perps-core/tags)                                                                       |

`main` tracks production releases, `develop` is the integration branch, and `version_*` branches hold release-specific work. A branch or tag identifies source code; it does **not** prove which version is deployed on a network. Use the [deployment registry](https://docs.symm.io/api-endpoints-and-deployments/symmio-perps-deployments) for live contract addresses.

## Documentation

| If you want to…                            | Start here                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Understand SYMMIO from first principles    | [What is SYMMIO?](https://docs.symm.io/protocol-architecture/protocol-introduction)                                       |
| Understand the protocol and contract flows | [Technical documentation](https://docs.symm.io/protocol-architecture/technical-documentation)                             |
| Build an exchange on SYMMIO                | [Frontend builder documentation](https://docs.symm.io/exchange-builder-documentation/frontend-builder-technical-guidance) |
| Integrate as a solver or market maker      | [Liquidity provider documentation](https://docs.symm.io/liquidity-provider-documentation)                                 |
| Review changes between contract versions   | [Versioned release notes](docs/index.html)                                                                                |
| Find deployed contracts and API endpoints  | [Deployments](https://docs.symm.io/api-endpoints-and-deployments/symmio-perps-deployments)                                |
| Deploy or operate the contracts            | [Deployment runbook](docs/deployment.md)                                                                                  |

To browse the versioned documentation site locally:

```bash
npm run docs
```

## Development

The project uses Node.js, npm, Hardhat, Solidity, TypeScript, Mocha, and Chai.

```bash
# Install the locked dependency tree
npm ci

# Compile contracts and check contract sizes
npm run compile

# Run the test suite in parallel
npm test
```

Useful focused commands:

```bash
# Run tests sequentially
npx hardhat test mocha

# Run tests matching a name
npx hardhat test mocha --grep "Test name"

# Run lint checks
npm run lint

# Validate the in-repository documentation
npm run docs:check
```

Tests use `MockMuonSignatureVerifier`, which accepts test signatures without performing real Muon verification.

The fuzz runner uses direct core users, AccountLayer sub-accounts, and signed InstantLayer batches in the same quote lifecycle. Its seeded corner campaigns cover POSITION, MARKET, MARKET_DIRECTION, and CUSTOM isolation, partial fills/closes, margin transfers, cleanup, and address reuse. Additional campaigns exercise single-VA mode and isolation keys, live ownership transfer/deletion, funded legacy imports, safe margin removal and orphan recovery, and selector timelocks through both layers. InstantLayer campaigns cover direct/by-signature/in-batch delegation grants, revocation and expiry, authenticated flex fills, result-chained instant-open templates, contract PartyB relays, and atomic rollback across accounts.

```bash
# Run a bounded campaign with full validation and all nineteen campaign families
FUZZ_SEED=layer-features FUZZ_ROOT_ACTIONS=38 npm run test:fuzz:ci

# Keep generating flows until Ctrl+C
npm run test:fuzz
```

Every queued fuzz action is followed by an exact money-conservation check: the sum of all internal ledger buckets (free and allocated balances, PartyB buckets, reserve vaults, reimbursement, liquidation escrow, deferred balances, reserved open fees, withdraw lock) must equal the collateral the diamond holds. A violation fails the run with the seed, action index and a per-bucket breakdown. `FUZZ_CONSERVATION_ORACLE=off` disables the per-action check; the corner campaigns still verify it explicitly. `FUZZ_LIQUIDATION_SCENARIOS=all` adds LATE, OVERDUE, mixed-solver OVERDUE, deferred, snapshot and pending-quote PartyA liquidations plus an oracle-checked PartyB liquidation to the corner bag:

```bash
# Liquidation scenarios through settlement, each step conservation-checked
FUZZ_LIQUIDATION_SCENARIOS=all npx hardhat test mocha --no-compile -- test/parallel/ConservationOracle.test.ts
FUZZ_LIQUIDATION_SCENARIOS=all FUZZ_SEED=oracle-1 FUZZ_ROOT_ACTIONS=40 npm run test:fuzz:ci
```

`test/utils/FuzzLiquidationGenerator.ts` adds a seeded random PartyA liquidation checked against a reference model (`test/utils/LiquidationModel.ts`): one to three solvers, one to six legs with random sides, sizes, prices and locked values, mixed books, partial opens and closes, pending and locked quotes, a price chosen to land in the NORMAL, LATE or OVERDUE band, solver allocations shaped around their expected and actual amounts, oracle values perturbed inside and beyond the rounding allowance, and the legacy, deferred or snapshot entry flow. The model predicts the liquidation type, deficit, liquidator fee, dispute flag, every solver's expected and actual amounts and CVA, the settlement deltas in random batches, PartyA's final balances and the escrow; the generator also checks locked-balance sums and exact conservation after every step. Each mismatch is a named violation (`TYPE`, `DEFICIT`, `DISPUTE`, `STATE:n`, `PLAN_SUM`, `SOLVER_CAP:n`, `SOLVER_DELTA:n`, `PARTYA_FINAL`, `CONSERVATION`, …). `FUZZ_KNOWN_VIOLATIONS="PLAN_SUM<=15,CONSERVATION<=15"` tolerates already-reported wei-level leaks so larger ones still fail; unset means exact. `FUZZ_LIQUIDATION_SCENARIOS=random` puts only this generator into the corner bag.

```bash
# 100 seeded random liquidations against the model; LIQ_ONLY=33,97 replays selected iterations
LIQ_SEED=sweep2 LIQ_ITERATIONS=100 npx hardhat test mocha --no-compile -- test/parallel/LiquidationModelFuzz.test.ts
FUZZ_LIQUIDATION_SCENARIOS=random FUZZ_SEED=random-1 FUZZ_ROOT_ACTIONS=40 npm run test:fuzz:ci
```

The default three users exercise all three routes. `FUZZ_USER_COUNT=1` keeps only the direct actor; `2` also includes AccountLayer. Layer campaigns remain in the corner-operation bag regardless of actor count. `FUZZ_CORNER_EVERY=0` disables that bag. Bounded runs that schedule at least nineteen corner campaigns require every family to succeed; operation counters appear in the fuzz logs and dashboard. The seed varies routes, amounts, directions, delays and isolation keys. Focused integration tests cover both template accounting modes and both execution-context protocols; a campaign counter records its family, not every parameter combination.

## Deployment and operations

Deployment is handled through the interactive operator application:

```bash
./symmio
```

Do not treat low-level Hardhat deployment tasks as the public operator interface. The application runs the required preflight, rehearsal, transaction reconciliation, verification, health, and handover steps. Read the [deployment runbook](docs/deployment.md) before operating against any live network.

## Repository map

```text
contracts/core/                   Core protocol diamond
contracts/accountLayer/           Account and affiliate system
contracts/instantLayer/           Batched execution layer
contracts/expressWithdrawLayer/   Express withdrawal provider
contracts/gaslessLayer/          Gas-sponsored operations layer
cli/                              Interactive operator application
test/                             Contract and deployment tests
docs/                             Release notes and operator guides
```

## License

The contracts are licensed under the [SYMM Core Business Source License 1.1](License). Review the [license documentation](https://docs.symm.io/legal-disclaimer/license) before production use.
