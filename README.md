# SYMMIO: Decentralized Derivatives Protocol

SYMMIO is a trustless hybrid clearing house (combining on-chain and off-chain components) acting as a communication,
settlement, and clearing layer for permissionless derivatives. At its core, SYMMIO is an intent-centric,
meta-derivatives engine, with its first use case being a new type of hyper-efficient perpetuals trading technology.

## Code Architecture

This project utilizes the Diamond Proxy pattern ([EIP-2535](https://eips.ethereum.org/EIPS/eip-2535)) for upgradability
and modularity. Currently, we have 29 facets:

1. **DiamondCutFacet** - Diamond upgrade operations (EIP-2535)
2. **DiamondLoupeFacet** - Diamond introspection (EIP-2535)
3. **AccountFacet** - Account management operations
4. **PledgeFacet** - Pledge collateral management
5. **BindingFacet** - PartyA-PartyB binding operations
6. **BridgeFacet** - Fast withdrawals
7. **ClearingHouseFacet** - Clearing house functionality
8. **ControlFacet** - Protocol control and configuration
9. **ExternalTransferFacet** - External transfer operations
10. **ForceActionsFacet** - Atomic force close and cancel operations
11. **ForceCloseStepsFacet** - 3-step force close flow (init, settle, finalize)
12. **FundingRateFacet** - Funding rate calculations
13. **MigrationFacet** - Cross partyB migration functionality
14. **PartyAFacet** - PartyA (trader) operations
15. **PartyALiquidationFacet** - PartyA liquidation logic
16. **PartyBAccountFacet** - PartyB account management
17. **PartyBBatchActionsFacet** - Batch operations for PartyB
18. **PartyBEmergencyActionsFacet** - Emergency close and ADL operations
19. **PartyBLiquidationFacet** - PartyB liquidation logic
20. **PartyBPositionActionsFacet** - PartyB position operations
21. **PartyBQuoteActionsFacet** - PartyB quote operations
22. **PauseControlFacet** - Emergency pause controls
23. **SettlementFacet** - Trade settlement logic
24. **SymbolControlFacet** - Trading symbol management
25. **ViewFacet** - General read-only queries
26. **ViewFacetAggregate** - Aggregated position and funding queries
27. **ViewFacetQuote** - Quote-related queries
28. **ViewFacetSymbol** - Symbol-related queries
29. **WithdrawFacet** - Withdrawal operations

### AccountLayer Diamond

The AccountLayer is a separate Diamond contract that manages account abstraction and affiliate functionality. It has 6 facets:

1. **ControlFacet** - Role management, pause control, and protocol configuration
2. **CoreFacet** - Sub-account and virtual account management, call execution
3. **MarginFacet** - Margin addition and removal operations
4. **AffiliateFacet** - Affiliate registration, management, fee distribution, and hook configuration
5. **ViewFacet** - Read-only queries for accounts, affiliates, and system state
6. **SymmioHookFacet** - Callback hooks for position close and quote cancel events from Symmio core

### Additional Contracts

There are also some additional second-layer contracts required by hedgers and frontends:

1. **InstantLayer**:
   This contract enables instant trade execution and settlement features.
2. **SymmioPartyB**:
   This contract enables hedgers to have multiple private keys behind their bots.

## Getting Started

This project uses [Hardhat](https://hardhat.org/). You can compile the code with:

```bash
npx hardhat compile
```

## Deployment

Deployments are driven by the `symmio` operator CLI:

```bash
./utils/yarn-classic.sh cli --help
```

The usual path:

```bash
./utils/yarn-classic.sh cli recipe init --network arbitrum
./utils/yarn-classic.sh cli doctor --config deployments/arbitrum.json
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json --plan
./utils/yarn-classic.sh cli deploy --config deployments/arbitrum.json
./utils/yarn-classic.sh cli status --config deployments/arbitrum.json
```

The versioned JSON recipe is the single source of public deployment intent. It can deploy
the full system or create a smaller add-on recipe with
`recipe init --only partyB|symbolManager`.
Private keys, RPC URLs, and explorer credentials stay outside JSON behind named Hardhat
keystore references. `doctor` exits non-zero on blocking configuration or chain-state
problems, so it can gate CI; encrypted entries that have not been unlocked are labeled as
deferred warnings and are rechecked by Hardhat before any write. ExpressProvider is
represented explicitly but currently fails closed before any transaction because post-payout
credit-loss settlement is unresolved and the recipe does not yet encode its production
roles, Muon/affiliate policy, Core registration, durable recovery, verification, and
complete post-state proof.

- **[docs/deployment.md](docs/deployment.md)** — the full deployment runbook: configuration,
  fork rehearsal, resuming a failed run, slow chains, and the manual steps the deployer
  cannot perform
- **[cli/README.md](cli/README.md)** — CLI command reference
- **[SCRIPTS_AUDIT.md](SCRIPTS_AUDIT.md)** — the audit behind the deploy-path safeguards,
  and what remains open

### Running Tests

Run the test suite with:

```bash
npx hardhat test mocha
```

Tests use a `MockMuonSignatureVerifier` contract deployed during test initialization, which accepts all signatures without verification. This allows tests to run without needing real Muon signatures.

#### Test Commands

```bash
# Run all tests sequentially
npx hardhat test mocha

# Run with coverage
npx hardhat test mocha --coverage

# Run specific tests
npx hardhat test mocha --grep "MyTest"

# Bring up three users and two hedgers; run until Ctrl+C
npm run test:fuzz

# Run the bounded deterministic CI/replay form
npm run test:fuzz:ci

# Replay a reported fuzz failure for exactly 50 root actions
FUZZ_SEED=reported-seed FUZZ_ROOT_ACTIONS=50 npm run test:fuzz:ci
```

The live fuzz runner deploys its own local Hardhat fixture, brings up three roaming users and two hedgers, and continuously selects a seeded-random user/hedger pair for each new quote. Open positions can remain alive between roots and a world tick revisits one existing position, so the run maintains concurrent exposure instead of draining every quote immediately. A seeded shuffled campaign also executes real funding, settlement, modern force-close, targeted emergency-close, quote-expiry, PartyA-liquidation, and PartyB-liquidation workflows. PartyA liquidation uses a one-shot sacrificial account; the other workflows keep cycling. To keep a long soak responsive, the default profile validates 20% of ordinary transitions and runs one corner workflow every two roots. The first Ctrl+C stops new work, finishes the active action, drains the queue, and prints a `STOPPED` summary; a second Ctrl+C forces an immediate exit.

`npm run test:fuzz:ci` uses the same Hardhat runner and actor model, enables validation for every selected ordinary transition, runs a corner workflow on every root, and stops after `FUZZ_ROOT_ACTIONS` (default 10). The default bounded run therefore covers the complete seven-operation corner bag, including quote expiry and pending-quote liquidation. Failure and stopped-run output includes a bounded CI replay command, so an observed live sequence can be rerun deterministically. Explicit `VALIDATION_PROBABILITY`, `FUZZ_PROGRESS_EVERY`, and `FUZZ_CORNER_EVERY` values override either profile and are included in replay commands.

`npm run test:fuzz:dashboard` runs the same continuous Hardhat world while serving a dependency-free visual report on loopback. The terminal remains available for immediate health checks; the browser adds live throughput and latency charts, quote-stock history, all 11 lifecycle states, queue pressure, action and validator coverage, the seven rare paths, partial execution, recent activity, and the exact replay command. The dashboard persists one bounded atomic snapshot to `.fuzz-dashboard/report.json` and archives the completed run under `.fuzz-dashboard/runs/`. The first Ctrl+C drains and finalizes the fuzz world while leaving its report available; press Ctrl+C again when finished reviewing it. `FUZZ_DASHBOARD_PORT`, `FUZZ_DASHBOARD_FILE`, and `FUZZ_DASHBOARD_ARCHIVE_DIR` customize presentation only and do not alter the seeded trace or replay fingerprint.

Fuzz output is run-scoped and replay-oriented:

- `FUZZ_LOG_LEVEL=summary` prints the effective run plan and final result.
- `FUZZ_LOG_LEVEL=progress` is the default. In a real terminal, a fixed live dashboard shows throughput, queue health, the current protocol action, and the complete quote inventory without growing the scrollback. Redirected output and bounded CI use permanent checkpoints instead.
- `FUZZ_LOG_LEVEL=trace` prints every queued action, selected user/hedger decision, state dispatch, and terminal outcome.
- `FUZZ_LOG_FORMAT=json` emits one bigint-safe JSON object per line for CI ingestion.
- `FUZZ_LOG_COLOR=auto|always|never` controls only the human-readable format and honors `NO_COLOR`.

The quote inventory keeps all 11 lifecycle states visible, including zero counts, and separately reports LONG/SHORT direction, opening LIMIT/MARKET mode, active close-request mode, and partial execution. `LIQUIDATED_PENDING` is shown as `liquidated before open`, an ended outcome: liquidation consumed a still-pending quote, so it is not counted as live exposure. A `split open` is detected from the parent/remainder relationship created by a partial fill. `Active split positions` counts opened legs anywhere in that lineage, while `waiting remainders` counts only child quotes still in PENDING, LOCKED, or CANCEL_PENDING, so the two counters do not overlap. `Partial close request` means the requested close quantity is smaller than the remaining open amount; `partially closed` means `0 < closedAmount < quantity`. A separate `CORNERS` row reports attempted/succeeded/skipped/failed totals for funding, settlement, force close, emergency close, quote expiry, and both liquidation sides. These counters reuse semantic events from the transactions under test; the dashboard does not poll per refresh.

The live dashboard changes from `RUNNING` to `DRAINING` as soon as Ctrl+C is received, then clears itself before printing the permanent result. Every PASS, STOPPED, and FAIL report preserves the final quote breakdown, deterministic trace fingerprint, and one shell-safe bounded replay command with the behavior-affecting probabilities and timeouts. Failures are classified as setup, execution, drain, or verification errors and include a bounded tail of recent actions even when the selected log level is `quiet`.

The fuzz reporter bypasses the legacy model logger by default. Set `FUZZ_LEGACY_LOG_LEVEL` only when the older validator/debug stream is also needed. File logging is opt-in through `DETAILED_LOG_FILE`; normal test runs no longer append to `detailedDebug.log`.

#### Parallel Test Execution

For faster execution, use the parallel test runner which runs tests across multiple workers:

```bash
# Run all tests in parallel (default: 8 workers)
./utils/runTestsInParallel.sh

# Customize number of parallel workers
PARALLEL_JOBS=4 ./utils/runTestsInParallel.sh
```

The parallel runner displays live progress and aggregated results with colorful output.

#### Environment Configuration

- **`.env` file**: Legacy scripts may source it. Recipe-driven deployment deliberately does not.
- **`PARALLEL_JOBS`**: Number of parallel test workers (default: 8)
- **`FUZZ_SEED`**: Optional seed for replaying a model-based fuzz run
- **`FUZZ_RUN_MODE`**: Continuous soak execution or bounded CI/replay execution
- **`FUZZ_USER_COUNT`**: Active user controllers (default: 3, maximum: 3)
- **`FUZZ_HEDGER_COUNT`**: Active hedger controllers (default: 2, maximum: 2)
- **`FUZZ_ROOT_ACTIONS`**: Root quote actions in bounded CI mode (default: 10)
- **`FUZZ_PROGRESS_EVERY`**: Continuous-mode root progress interval (default: 1; explicit values override the profile)
- **`FUZZ_CORNER_EVERY`**: Roots between deliberate corner workflows (default: `2` continuous, `1` bounded; `0` disables them)
- **`VALIDATION_PROBABILITY`**: Probability of running the expensive transition validator (default: `0.2` continuous, `1` bounded)
- **`FUZZ_RETHINK_DELAY_MS`**: Delay before a controller reconsiders a no-op quote state (default: 100)
- **`FUZZ_RUN_TIMEOUT_MS`**: Maximum time for each root action cascade to reach idle (default: 30000)
- **`FUZZ_LOG_LEVEL`**: Fuzz reporter detail (`quiet`, `summary`, `progress`, or `trace`)
- **`FUZZ_LOG_FORMAT`**: Human-readable `pretty` output or newline-delimited `json`

### Log Levels

Recipe-driven deployments set `execution.logLevel`; tests and legacy direct tasks can still
set `DEPLOY_LOG_LEVEL`:

| Level     | Description                                                              |
| --------- | ------------------------------------------------------------------------ |
| `silent`  | Suppress routine component logs; transactions/errors remain (tests only) |
| `minimal` | Summary output only                                                      |
| `verbose` | Full deployment details with formatted output and separators             |

Examples:

```bash
# Run tests with silent logs (default)
npx hardhat test mocha

# Run tests with verbose deployment logs
DEPLOY_LOG_LEVEL=verbose npx hardhat test mocha

# Run parallel tests with minimal logs
DEPLOY_LOG_LEVEL=minimal ./utils/runTestsInParallel.sh
```

## Documentation

For detailed technical documentation, visit:

[https://docs.symm.io/protocol-architecture/technical-documentation](https://docs.symm.io/protocol-architecture/technical-documentation)

## License

SYMM-Core-Business-Source-License-1.1

For more information, see https://docs.symm.io/legal-disclaimer/license
