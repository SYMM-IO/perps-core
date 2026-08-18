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
cli/                              Interactive operator application
test/                             Contract and deployment tests
docs/                             Release notes and operator guides
```

## License

The contracts are licensed under the [SYMM Core Business Source License 1.1](License). Review the [license documentation](https://docs.symm.io/legal-disclaimer/license) before production use.
