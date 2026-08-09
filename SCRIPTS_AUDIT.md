# SYMMIO perps-core -- Scripts and CLI Readiness Audit

Date: 2026-08-06
Branch: `version_0.8.6`
Scope: 162 TypeScript, JavaScript, and shell surfaces under `scripts/`, `tasks/`, `cli/`, and `utils/`, plus the Hardhat config, package/toolchain files, environment template, and deployment runbook.

## Verdict

The canonical core deployment path is locally ready for a production-shaped fork rehearsal:

```bash
./symmio recipe init --network arbitrum
./symmio doctor --config deployments/arbitrum.json
./symmio deploy --config deployments/arbitrum.json --plan
./symmio deploy --config deployments/arbitrum.json
```

The JSON recipe is the single public deployment input. Recipe-guided `deploy:system` is the
supported live entry point for a fresh core deployment; recipe-guided component execution
provides an independently scoped path for supported add-ons. Raw low-level component tasks
remain local/fork-only.

This verdict is based on source review, static gates, automated tests, and a complete local in-process deployment. It is not evidence of an Arbitrum fork rehearsal, live broadcast, explorer publication, production multisig execution, or final ownership acceptance.

## What changed

### Operator and configuration safety

- A strict, versioned JSON recipe now contains governance, collateral, Muon, protocol,
  template, component, and transaction settings. Unknown fields, invalid modes, inline
  secrets, and chain/scope mismatches fail before a transaction.
- Private values are named secret references only. Recipe mode deliberately bypasses `.env`;
  the checked-in example uses the encrypted Hardhat keystore.
- `core`, `partyB`, `symbolManager`, and `expressProvider` each declare `deploy`, `reuse`, or
  `skip`. A full run executes enabled components in dependency order; `--only` never silently
  deploys dependencies.
- `recipe init --only partyB|symbolManager` creates a minimal add-on JSON with a portable
  Core report reference instead of making the operator prune the full-system configuration.
- The normalized recipe digest is pinned across the CLI/Hardhat boundary. For a reused Core,
  the dependency report's exact bytes are also digest-bound and rechecked immediately before
  task execution.
- Live recipe runs have no dummy signer fallback. The deployer resolves only from the
  recipe's named keystore/CI-secret reference. Legacy `NEW_DEPLOYER` / `TEAM_DEPLOYER`
  handling remains compatibility-only; `PRIVATE_KEY` is deliberately rejected as unused.
- Known mainnets reject a mock Muon verifier, fake collateral, a dummy affiliate, a public test deployer, an implicit admin, and deployer-as-admin unless the explicit two-part unsafe override is supplied.
- PartyB and SymbolManager require explicit operational signer/operator addresses.
- The liquidation insurance vault, positive per-position profit cap, and soft-liquidation penalty collector are explicit requirements on known mainnets and their fork rehearsals. They are logged, manifest-bound, reported, written on-chain, and health-checked exactly.
- The Muon profile is the exact eight-category, case-sensitive set. New and reused verifiers are checked for keys, gateways, permissions, and repair authority before writes.
- The generated Arbitrum recipe embeds the currently reviewed 42161 protocol parameters and
  templates. Recipe initialization for other mainnets fails closed until a reviewed profile
  exists; it never fabricates values.

### CLI behavior

- Strict flag schemas reject unknown, duplicate, cross-command, and malformed boolean options.
- Recipe paths resolve consistently from the recipe file and checkout; legacy environment
  handling remains isolated to compatibility commands.
- `doctor` directly probes `eth_chainId`, signer/balance, collateral bytecode and metadata,
  Muon state, chain config, explorer requirements, and checkpoint disposition when those
  values are inspectable. Encrypted keystore entries are explicit deferred warnings and the
  Hardhat task resolves/rechecks them before checkpoint mutation or broadcast.
- `deploy` prints the resolved plan, uses risk-proportional confirmation, runs the canonical task, and refuses an incomplete or inconsistent handoff report.
- Persistent deploy runs use exit `2` for `pending_handover` and reserve `0` for lifecycle
  `complete`; ephemeral forks print the pending lifecycle without failing the rehearsal.
- `status` requires the exact full or component recipe/report/checkpoint and delegates to the
  matching comprehensive read-only on-chain health task.
- Full-system explorer retry is bound to the deployment ID, recipe digest/component modes,
  scoped verification records, and a versioned failed-record artifact. Component recipes
  cannot consume the full-system verifier.
- `config show/diff/export` remains the exact live-reading/migration utility for the 12
  protocol parameters and ordered templates. A deployment consumes the reviewed inline
  recipe copy, including the separate liquidation recipients/cap.

### Transaction and resume correctness

- Every deployment write records hash and nonce before receipt waiting, then records block, gas, cost, confirmations, replacements, and final status.
- Slow-transaction notices and bounded receipt timeouts are validated before deployment.
- A timed-out or interrupted broadcast is reconciled by exact hash/nonce/intent before resume. Unknown outcomes block progress and block `--fresh`.
- CREATE and CREATE2 contract creations are write-ahead bound to init code and expected address, preventing duplicate deployments after uncertain receipts.
- Checkpoints are atomically written with fsync, scoped by chain/simulation, bound to deployment id, source fingerprint, full config, protocol config, and CREATE2 intent.
- `--fresh` archives rather than overwrites. Corrupt, abandoned, active, and completed attempts have distinct paths.
- Diamond resume verifies the exact selector-to-facet map and can repair missing/replaced chunks without accepting a partial cut.
- Template, affiliate, PartyB, and optional component resume paths inspect on-chain state before repeating non-idempotent work.
- Confirmed setup setters are not blindly replayed after drift. The final live-state health gate fails and emits exact remediation.

### Logging and evidence

- `execution.logLevel: "verbose"` is the recipe/operator default; warnings, failures,
  transaction evidence, verification, and health results remain visible at reduced levels.
- The large Ethers `Invalid Fragment` noise from the two Solidity 0.8.18 public-library ABIs is removed with deployment-only factories. Compiler bytecode, link references, verification artifacts, and Solidity library selectors are unchanged.
- Deployment reports include lifecycle, resolved configuration, addresses, transactions, component summary, health/verification policy, and exact remaining manual actions.
- Health checks fail on unreadable critical probes, missing exact facets/templates/roles, active transient signer sessions, zero liquidation receivers, nonpositive caps, or deployer privilege residue.
- Ownership acceptance and SymbolManager operator grants are reported as explicit pending-handover warnings, not hidden or mislabeled as complete.

### Scripts and upgrade tooling

- On-chain mutation scripts are plan-only by default and require literal `EXECUTE=true` plus a matching `CONFIRM_CHAIN_ID`; Safe service submission additionally binds the exact Safe.
- Generic `upgrade:proxy` can execute only locally/on a fork because it cannot prove live storage-layout compatibility. Live proxy changes require a reviewed target-specific script.
- Generic and dedicated liquidation-parameter upgrade paths reject incomplete pairs, zero recipients, zero/non-decimal/overflow caps, and generate reviewable calldata/Safe artifacts.
- Migration progress is atomically persisted and bound to the exact input and task scope. Fork runs cannot persist a skip-precheck shortcut.
- Obsolete, orphaned, or unsafe one-off scripts were removed; retained chain-specific scripts now have explicit plans/guards.
- Express Layer recipe deployment remains intentionally blocked. Credit accounting is
  already inside the diamond and Core advance support exists; there is no missing external
  CreditLineManager. Post-payout loss coverage currently reduces affiliate liability without
  transferring or reclassifying the matching collateral, so settlement conservation is
  unresolved. A reviewed role/Muon/affiliate schema, fail-closed affiliate policy, durable
  recovery, Core registration and ownership handover, explorer records, and canonical
  post-state proof are also still required.

### Toolchain and tests

- `.node-version` pins Node `22.15.0`.
- `utils/pinned-yarn.sh` and the `preinstall` hook (`scripts/check-package-manager.js`) enforce Yarn Classic `1.22.22`; `yarn.lock` fixes the dependency graph. The frozen graph currently installs Hardhat `3.12.0`. `utils/yarn-classic.sh` remains as a deprecated alias.
- `check:operations` runs Solidity lint, operations TypeScript checking, CLI tests, compilation, and focused deployment/recovery tests.
- The parallel runner invokes the local Hardhat binary, honors worker exit codes, and isolates tests from deployment variables loaded from `.env` or the parent shell.

## Current evidence

### Automated gates

- Solidity lint, operations TypeScript checking, formatting, and diff hygiene: passed.
- CLI tests: 87 passed.
- Focused deployment/recovery/upgrade tests: 91 passed against the compiled artifacts.
- Express/withdraw regression suites: 422 passed against the current Express contracts and a real Core diamond (with mock Muon verification).
- Clean environment-isolated sequential suite: 1,763 passed with deployment secrets disabled.
- Last complete parallel repository sweep: 4,306 tests across 83 suites passed before the final CLI status/verification and Express deployment-helper changes; the affected current surfaces are covered by the newer CLI, focused, Express, and sequential results above.
- A final aggregate `check:operations` invocation passed both lints and all CLI tests, then the sandbox blocked Hardhat from creating its compiler-cache mutex under `~/Library/Caches`. Compilation had already passed before the final non-Solidity changes, so this is recorded as an environment limitation rather than a green aggregate gate.

### Fresh local deployment rehearsal

Report: `tasks/data/31337-fork/deployment-report.json`
Deployment id: `067016ed-244c-4053-8e5f-fd694564ae7e`

- 192 of 192 recorded transactions confirmed.
- 7 deployment groups succeeded; 0 failed; 0 reused.
- Core: 32 facets and 443 exact selectors.
- AccountLayer: 8 facets and 103 exact selectors.
- Muon: one key and one gateway authorized across all eight categories.
- Health: 175 passed, 0 failed, 4 expected handover warnings.
- Both Core and AccountLayer transient signer sessions were proven cleared using zero-sender `eth_call` probes.
- Lifecycle: `pending_handover`, because the simulated admin has not accepted both ownership transfers or granted the two SymbolManager operator roles.
- Explorer verification: not applicable to the ephemeral local network.

The rehearsal used controlled non-secret fixture addresses and local-only defaults. It did not read or validate the operator's real `.env` values.

## Remaining live gates

Before broadcasting to Arbitrum:

1. Use a clean shell and the checked-in Node/Yarn toolchain.
2. Create and review `deployments/arbitrum.json`, including admin, collateral, Muon, PartyB,
   SymbolManager, protocol parameters/templates, and the three liquidation-accounting values.
3. Run `./symmio doctor --config deployments/arbitrum.json` and resolve every failure.
4. Render and independently review `./symmio deploy --config deployments/arbitrum.json --plan`.
5. Complete the matching fork recipe against the intended private RPC and pinned block when reproducibility matters.
6. Review the fork report, transaction evidence, health summary, and manual actions.
7. Run the live recipe only after the fork result is accepted. Mainnet non-interactive mode requires `--yes --confirm-network arbitrum` and cannot skip verification.
8. Execute the exact report `manualActions` through the production admin, rerun deployment/status, and require lifecycle `complete` plus explorer verification `passed`.

## Explicit limitations

- No live chain transaction, explorer verification, or multisig proposal was submitted in this audit.
- No Arbitrum fork rehearsal was run because it needs the operator's production-shaped configuration and RPC.
- Express Layer is not part of `deploy:system` and is not live-ready through its standalone helper.
- Express credit affiliates currently fail open when no explicit affiliate configuration exists, because zero limits mean unlimited and there is no enabled marker. Together with the post-payout loss-accounting issue above, this is a production blocker; the recipe rejects Express before sending any transaction.
- The final aggregate gate could not reacquire Hardhat's compiler-cache mutex inside this restricted sandbox. Current CLI, focused, Express, and clean sequential tests passed using the already-compiled artifacts; this is not fresh compile evidence for the final tree.
- Release metadata still says package version `0.8.5` on branch `version_0.8.6`; this audit did not make a release-version decision.
- The current interactive login shell emits `(eval):5: parse error near 'end'`; all validation here used a clean non-login shell. Fix that shell startup issue before the deployment session so it cannot contaminate operator commands.
- `tasks/data/instantlayer.json` and `tasks/data/partyb.json` are pre-existing, unrelated working-tree changes and were intentionally not modified by this audit.
- Versioned docs under `docs/v0.8.5/` and `docs/v0.8.6/` were not changed; the operational runbook is `docs/deployment.md`.
