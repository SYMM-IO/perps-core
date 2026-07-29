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
```

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

- **`.env` file**: Automatically sourced if present in the project root
- **`PARALLEL_JOBS`**: Number of parallel test workers (default: 8)

### Log Levels

The deployment scripts support different log levels controlled via the `DEPLOY_LOG_LEVEL` environment variable:

| Level       | Description                                                  |
| ----------- | ------------------------------------------------------------ |
| `silent`  | No deployment output (default for tests)                     |
| `minimal` | Summary output only                                          |
| `verbose` | Full deployment details with formatted output and separators |

Examples:

```bash
# Run tests with silent logs (default)
npx hardhat test mocha

# Run tests with verbose deployment logs
DEPLOY_LOG_LEVEL=verbose npx hardhat test mocha

# Run parallel tests with minimal logs
DEPLOY_LOG_LEVEL=minimal ./utils/runTestsInParallel.sh
```

### Exporting deployed contract ABIs

Use the read-only live exporter to assemble ABIs and selector-provenance reports for every named Diamond,
proxy, or standard contract in a chain config:

```bash
npm run abi:diamond -- --chain hyperevm
```

See [scripts/docs/export-diamond-abi.md](scripts/docs/export-diamond-abi.md) for per-chain configuration, provenance rules, and output details.

## Documentation

For detailed technical documentation, visit:

[https://docs.symm.io/protocol-architecture/technical-documentation](https://docs.symm.io/protocol-architecture/technical-documentation)

## License

SYMM-Core-Business-Source-License-1.1

For more information, see https://docs.symm.io/legal-disclaimer/license
