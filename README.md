# SYMMIO: Decentralized Derivatives Protocol

SYMMIO is a trustless hybrid clearing house (combining on-chain and off-chain components) acting as a communication,
settlement, and clearing layer for permissionless derivatives. At its core, SYMMIO is an intent-centric,
meta-derivatives engine, with its first use case being a new type of hyper-efficient perpetuals trading technology.

## Code Architecture

This project utilizes the Diamond Proxy pattern ([EIP-2535](https://eips.ethereum.org/EIPS/eip-2535)) for upgradability
and modularity. Currently, we have 22 facets:

1. **AccountFacet** - Account management operations
2. **MasterAccountMigrationFacet** - Master account migration functionality
3. **ControlFacet** - Protocol control and configuration
4. **SymbolControlFacet** - Trading symbol management
5. **PauseControlFacet** - Emergency pause controls
6. **DiamondLoupeFacet** - Diamond introspection (EIP-2535)
7. **LiquidationFacet** - Position liquidation logic
8. **PartyAFacet** - PartyA (trader) operations
9. **BridgeFacet** - Fast withdrawals
10. **ViewFacet** - General read-only queries
11. **ViewFacetSymbol** - Symbol-related queries
12. **ViewFacetQuote** - Quote-related queries
13. **FundingRateFacet** - Funding rate calculations
14. **ForceActionsFacet** - Atomic force close and cancel operations
15. **ForceCloseStepsFacet** - 3-step force close flow (init, settle, finalize)
16. **SettlementFacet** - Trade settlement logic
17. **PartyBPositionActionsFacet** - PartyB position operations
18. **PartyBQuoteActionsFacet** - PartyB quote operations
19. **ClearingHouseFacet** - Clearing house functionality
20. **PartyBBatchActionsFacet** - Batch operations for PartyB
21. **WithdrawFacet** - Withdrawal operations

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
./utils/runTests.sh
```

The reason we cannot simply use `npx hardhat test` is that there are some Muon signature verification parts in the code
that need to be commented out for the tests to run without issues. This script automates that task.

#### Test Options

```bash
# Run all tests
./utils/runTests.sh

# Run with coverage
./utils/runTests.sh --coverage

# Run specific tests
./utils/runTests.sh --grep "MyTest"

# Run specific tests with coverage
./utils/runTests.sh --coverage --grep "MyTest"
```

#### Environment Configuration

The test script supports the following environment configurations:

- **`.env` file**: Automatically sourced if present in the project root
- **`PYTHON_VENV`**: Set this to your Python virtual environment path to auto-activate it

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
./utils/runTests.sh

# Run tests with verbose deployment logs
DEPLOY_LOG_LEVEL=verbose ./utils/runTests.sh

# Run tests with minimal logs
DEPLOY_LOG_LEVEL=minimal ./utils/runTests.sh
```

## Documentation

For detailed technical documentation, visit:

[https://docs.symm.io/protocol-architecture/technical-documentation](https://docs.symm.io/protocol-architecture/technical-documentation)

## License

SYMM-Core-Business-Source-License-1.1

For more information, see https://docs.symm.io/legal-disclaimer/license
