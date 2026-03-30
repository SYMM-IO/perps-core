# Repository Guidelines

## Start Here (Agent Context)
- Read `AGENTS.md` and `README.md` first, then skim `hardhat.config.ts` for network/task settings.
- Key architecture: Diamond Proxy (EIP-2535) with many `*Facet.sol` contracts in `contracts/`, plus non-facet contracts like `InstantLayer` and `SymmioPartyB.sol`.
- Common workflows live in `scripts/`, `tasks/`, and `utils/` (parallel test runner).

## Project Structure & Module Organization
- `contracts/`: Solidity contracts organized around Diamond facets (`*Facet.sol`) plus supporting libraries.
- `test/`: Hardhat tests in TypeScript; common patterns: `*.behavior.ts` for behavior suites and `*.fixture.ts` for setup.
- `docs/`: documentation and specs.
- `scripts/` and `tasks/`: Hardhat scripts and task definitions for deployments and ops.
- `utils/`: helper scripts (for example, `utils/runTestsInParallel.sh`).
- Generated outputs: `artifacts/`, `cache/`, `abis/`, `src/types/` (TypeChain).

## Build, Test, and Development Commands
- `yarn compile` / `npx hardhat compile`: compile Solidity sources.
- `yarn test`: run tests in parallel via `utils/runTestsInParallel.sh` (default 8 workers).
- `npx hardhat test mocha`: run tests sequentially; add `--grep "Name"` to filter.
- `yarn coverage`: coverage via Hardhat/Mocha.
- `yarn lint`: run Solidity + TypeScript linting.
- `yarn typechain`: regenerate TypeChain bindings.

## Coding Style & Naming Conventions
- Formatting is enforced with Prettier (`.prettierrc.yml`): tabs by default, `printWidth: 150`; TypeScript overrides to 2-space width and `semi: false`.
- Run `yarn prettier:contracts` or `yarn prettier:ts` before submitting changes.
- Solidity linting uses `solhint` via `yarn lint:sol` with `.solhint.json`.

## Testing Guidelines
- Frameworks: Hardhat + Mocha + Chai.
- Tests use `MockMuonSignatureVerifier` (auto-deployed) so signature validation is mocked.
- For parallel runs, set `PARALLEL_JOBS=4` to tune workers.

## Commit & Pull Request Guidelines
- Recent commits follow a conventional style: `feat: ...`, `fix: ...`, `refactor(script): ...`.
- Keep messages short, present tense, and add a scope when helpful.
- No PR template found; include a concise summary, tests run, and any config/env changes.

## Configuration Notes
- `.env` in repo root is auto-sourced.
- `DEPLOY_LOG_LEVEL` controls deployment/test script verbosity (`silent`, `minimal`, `verbose`).

## AccountLayer Deployment Notes
- `deploy:system` wires roles/whitelists across Core/AccountLayer/InstantLayer, but manual AccountLayer deploys need extra setup.
- AccountLayer requires the core hook registration (`ControlFacet.registerHook(address(0), accountLayerDiamond)`) so virtual account cleanup works.
- Core must be whitelisted on AccountLayer (`setWhitelistedSymmioCore`), and AccountLayer must be granted `SIGNER_ADMIN_ROLE`, `AFFILIATE_MANAGER_ROLE`, and `BALANCE_SETTLER_ROLE` on Core.
- For repeatable setup, use `scripts/setupAccountLayer.ts` (reads from `.env`, supports multi‑affiliate hooks, logs to `tasks/data/accountlayer-setup.log`).
