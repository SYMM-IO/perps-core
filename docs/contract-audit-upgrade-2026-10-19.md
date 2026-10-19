# Contract audit integration and upgrade preparation

The audit branch now includes the current `version_0.8.6` release state (`f7c59374`), the F-009 admission-time bucket fix, and the regression-test race correction. The implementation is committed at `02d54089a15dae814333c5ff6b6158c9cf539c98`. Netting economics are unchanged from the existing audit branch. On 19 October the product owner explicitly deferred that decision; this remains a release gate.

## Implemented follow-ups

- The instant-open regression resolves the error-contract instance before starting the transaction, so its expected revert cannot escape its assertion handler.
- `npm test` invokes the Node runner directly on Windows and Unix. Workers load TypeScript explicitly, ignore deployment credentials and `.env`, and preserve test filters and the configured worker count.
- Two contract-test assertions now handle Windows paths and the host number locale. UI tests explicitly use English numbers, matching their fixtures while preserving product formatting.
- The lockfile includes the three missing transitive `@noble/hashes` entries required by the existing UI dependencies. Existing package versions are unchanged. A separate clean install succeeded without modifying packages used by running contract tests.
- `scripts/audit/check-storage-layout.mjs` compares compiler-derived member slots, offsets and recursive types against the audit baseline. It checks the real namespace constants and `layout()` bindings, verifies unchanged OpenZeppelin lock entries/installed versions, and records imported dependency source hashes.
- `scripts/audit/inspect-deployment.mjs` reads configured deployment addresses at a recorded block, verifies that block's hash again, records code/facets/roles/templates/keys, and flags incomplete required reads. New epoch getters may legitimately be absent before upgrade. The optional all-quote scan checks every assigned quote ID and identifies pending-status quotes missing from pending arrays and accounts still in liquidation.
- `AuditCoordinatedUpgrade.test.ts` checks missing-epoch failure, selector installation/facet replacement, retained account/grant/template/timelock state, and invalidation after ownership transfers. It starts with current artifacts; it is a local facet-cut rehearsal, not proof of upgrading a particular deployed version.

## Netting decision pending

Consider PartyA quote PnL of `+100` and `-100` against solver X, and `-1000` against solver Y, with a residual deficit of `100`.

| Rule                            | Solver X                                            | Solver Y                      |
| ------------------------------- | --------------------------------------------------- | ----------------------------- |
| Existing per-position haircut   | Pays PartyA approximately 9.09 despite net-flat PnL | Receives approximately 909.09 |
| Audit branch per-PartyB netting | Pays/receives zero                                  | Receives 900                  |

Both distribute the available net 900, but allocate the deficit differently. Rounding is simplified here. The implemented netting regression covers this class of difference. Core/Muon maintainers must reconcile the selected rule with SYM-1525 before release; a passing test does not settle the product decision.

## Deployment inventory and recovery boundaries

The repository identifies Vibe Arbitrum production and staging. Initial pinned-block reads found both lack the two new epoch getters, have valid registered Muon-key ranges, and expose 16 InstantLayer templates. Known target checks admitted Core and AccountLayer and rejected the configured Gasless/Express addresses. These checks do not enumerate every whitelisted target or role holder.

The all-quote scan completed with account-read failures included in its completeness result:

| Deployment            | Pinned block | Assigned IDs scanned | Accounts checked for pending/liquidation state | Result                                                                                                      |
| --------------------- | ------------ | -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `arbitrum-vibe`       | 516256501    | 1–9911               | 207                                            | No missing-pending-array candidates, no liquidating accounts among those checked, no failed required reads. |
| `vibe-arbitrum-stage` | 516258475    | 1–308                | 23                                             | No missing-pending-array candidates, no liquidating accounts among those checked, no failed required reads. |

Both pinned block hashes were rechecked. The [full inventory](audit/2026-10-19/deployment-inventory.json) retains addresses, facets, code hashes, configuration and per-account reads. The account checks cover quotes outside canceled/closed/expired statuses; they are not a census of every account ever created.

Read-only scans cannot reconstruct a liquidation's original allocation bucket or an ownership transfer that predates epoch tracking. A candidate requires transaction/event history and an explicit reconciliation plan; scanning current storage is not a balance repair.

Before a real upgrade, obtain the source/build identity for the actual deployed facets and linked libraries, the full ownership-transfer/delegation history, the global-relayer inventory and trusted manager pairs, and real Muon signature vectors/source version. The address book supplies addresses but does not prove those source identities.

## Coordinated rollout

1. Resolve netting semantics and real Muon compatibility, and rehearse against a fork of the verified deployed baseline.
2. Inventory and settle in-flight legacy liquidations, or pause mode changes and reconcile original buckets. Identify malformed historical atomic quotes and stale grants from pre-upgrade transfers; define exact recovery actions before execution.
3. Pause affected routes through the established operator workflow. Replace the affected Core facets and linked implementations together; the batch facet must link the revised `PartyBPositionActionsFacetImpl` containing `openPositionState`.
4. Upgrade AccountLayer Core/View and InstantLayer Delegation/Execution/View/Migration together. Include `getAccountOwnershipEpoch(address)` and `delegationOwnershipEpoch(address,address,bytes4)` in the cut. Preserve timelock state deliberately.
5. Upgrade any affected relayer proxy and configure reviewed source/account-manager pairs before resuming. Recheck manager code and upgrade authority.
6. Update SDK/solver signing so every template insertion has an exact signed 32-byte flex field and actual-value filler authorization. Existing EIP-712 operation types/selectors remain unchanged.
7. Verify selectors, linked code, roles, grants, templates, pending accounting, liquidation settlements and collateral reconciliation at the deployed addresses before enabling routes.

Use `docs/deployment.md` and the repository operator application. No live upgrade, balance mutation, role change, or Safe proposal is performed by these preparation steps.

## Reproducing the local checks

Run `npm ci` from the repaired lockfile, followed by `PARALLEL_JOBS=2 npm test` (set the variable with PowerShell syntax on Windows), `npm run test:runner`, `npm run test:audit-tools`, `npm run lint`, and `npm run test:ui:web`.

Run the compiler proof with `node scripts/audit/check-storage-layout.mjs --base 1338f181 --solc <Solidity-0.8.36-executable> --output <report.json>`.

The bounded campaign used `DOTENV_CONFIG_PATH=NUL`, `USE_KEYSTORE=false`, `TEST_MODE=fuzz`, `FUZZ_RUN_MODE=bounded`, `FUZZ_SEED=sym-1738-integrated-2026-10-19` and `FUZZ_ROOT_ACTIONS=38`, followed by `node --import tsx node_modules/hardhat/dist/src/cli.js test mocha --no-compile --bail -- test/sequential/Main.ts`. Use `/dev/null` for the dotenv path on Unix.

Run the read-only inventory with `node scripts/audit/inspect-deployment.mjs --deployment arbitrum-vibe --deployment vibe-arbitrum-stage --all-quotes --output <report.json>`. It uses the address book's public RPC unless `AUDIT_RPC_URL` is supplied. Treat any incomplete read status as unresolved evidence.

## Validation on the integrated source

| Check                                 | Result                                                                                                                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full contract suite                   | 3,690 passed and two portability assertions failed. Both were corrected; all 29 tests in the affected wrappers passed on rerun. The new local coordinated-upgrade test also passed, giving 3,693 contract tests validated across the full run and focused rerun. |
| Bounded seeded fuzz                   | Passed: 38 root actions, all 19 corner-campaign families, zero skipped/failed corners. Seed `sym-1738-integrated-2026-10-19`.                                                                                                                                    |
| Compile and size gate                 | Passed: 261 deployable artifacts, five size warnings, zero failures. The liquidation library has 151 bytes left below the release budget.                                                                                                                        |
| Lint / TypeScript / UI types          | Passed; the UI setup was typechecked again after the locale correction.                                                                                                                                                                                          |
| UI browser tests                      | 116 passed across 13 files.                                                                                                                                                                                                                                      |
| Test runner and inventory regressions | Three runner tests and three inventory tests passed. Inventory tests cover missing code, failed required/account reads and bounded ID ranges above one million.                                                                                                  |
| Compiler storage proof                | Passed against `1338f181`: 13 existing AccountLayer members, five InstantLayer delegation members, and two ordinary relayer members preserved. Inherited namespace scope is stated in the report.                                                                |
| Review                                | Both standards and spec reviewed; the inventory completeness and range-cap findings were fixed and re-reviewed.                                                                                                                                                  |

This is source-level integration evidence. A fork rehearsal against verified deployed code, real Muon vectors, and historical recovery remain open release gates.

The [compiler storage report](audit/2026-10-19/storage-layout.json) and [validation manifest](audit/2026-10-19/validation.json) bind the evidence to the implementation revision and toolchain.

## Inputs still needed from the owners

1. Product/Core: decide OVERDUE netting later, as requested, and record the remaining audit policy decisions for ADL/funding and retained Express/fee behavior.
2. Core/Muon maintainers: supply the approved Muon source/build version and real signature/payload vectors, including legacy liquidation IDs and timestamps.
3. Deployment operators: identify verified source/builds and deployment blocks for the live facets/libraries, provide full ownership/delegation and liquidation history, and list global relayers with trusted manager pairs. This enables the actual deployed-version fork rehearsal and any necessary historical repair plan.

The eventual live upgrade and any balance/role changes need operator review and execution after those gates are satisfied. The branch is ready for further review; it is not approved for deployment.

Local logs and reports live under `tmp/SYM-1738/implementation-2026-10-19/`.
