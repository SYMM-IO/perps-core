# Arbitrum Vibe stage funding upgrade: suffix 863

This maintenance task replaces only `FundingRateFacet` on stage Core `0x573310dB6d160B26026B8706EBe9831c7dEF1D09`. It keeps the installed rounding upgrade and all other selectors. Governance uses Safe Transaction Builder files for the Dev Safe `0x89bE952790657297ac03f1954b22B668d819D3d9`.

The [stage recipe](../deployment-recipes/arbitrum-vibe-stage.json) now specifies facet suffix **863**. The task uses the [stage funding target](../tasks/config/arbitrum-funding-upgrade-vibe-stage-42161.json), which pins the old funding facet, existing rounding facets, complete baseline selector digest, collateral and reused funding library. The recipe also contains full-system deployment settings; choose this named maintenance task to execute the funding-only scope.

## Start through symmio

Use Node **22.15.0** and the prepared release checkout:

```bash
cd /home/home/Documents/Development/Symmio/perps-core/.releases/version_0.8.6.2
./symmio
```

Select **Other maintenance scripts → Arbitrum Vibe stage / Safe funding upgrade (863)**. The earlier stage rounding task is historical; the production Ledger task uses suffix **862** and a different Core.

The source remains **version_0.8.6.2-funding**, pointing to Solidity commit `9607ae6e17bc46f734a62e4b5028caf6eecae3ef` with contracts tree `110017b11256bfa472210c81d6e01b266e97a452`. Stage uses the same funding code as production with a different address suffix. No Solidity change or additional source tag is required. The script separately binds its commit, recipe digest and target digest and refuses source or input changes during a run.

1. The task selects the reviewed Dev Safe in **Safe Transaction Builder file** mode. Select the deployment signer separately, such as **Hardhat keystore → NEW_DEPLOYER**. The chosen key may differ from the recipe's default. Passwords belong only in the operator keystore prompt.
2. Review the Core, source tag, suffix and two-contract scope. The script compiles and checks the live owner/default-admin role, collateral, installed rounding baseline, preserved facet runtimes and reused library hash. Stage accumulated funding must already be enabled. Missing pause roles do not block deployment.
3. Type **`UPGRADE VIBE STAGE FUNDING 863 ON 42161`**. The deployment signer deploys and pays for the temporary factory and funding facet. It receives both admin and deployer roles on the factory. The script publishes both contracts on Arbiscan and checks their runtime bytecode and library links before any governance export.
4. Import the **role-grants JSON** into the Dev Safe. It contains only missing `PAUSER_ROLE` and `UNPAUSER_ROLE` grants, both to the Safe itself. Execute it, then choose **Continue active task**. The script verifies both roles on chain. If both roles already exist, this export is skipped.
5. Import the separate **global-pause JSON**, execute `pauseGlobal()`, then continue. The script checks the global pause flag before exporting the cut. If already paused, the redundant transaction is skipped.
6. Import the **funding-cut JSON**. Check the unchanged Core target, zero ETH value, one replacement facet ending in **863**, exactly seven replaced selectors, no additions/removals, zero initializer and empty initialization data. Execute it, then continue.
7. The script verifies the complete selector map, the funding runtime and library link, the preserved rounding facets and getter, and publication records while requiring Core to remain globally paused. Only after this succeeds does it export the separate **global-unpause JSON**.
8. Execute `unpauseGlobal()` from that file and continue. Completion requires the global flag to be cleared. Other pause flags are preserved.

Each Safe file has a separate intent digest and path. Import only the file printed for the current step. Generating a file does not sign, propose to a Safe service or execute a transaction. The Safe owner performs the external transactions; this task never asks for a Ledger or Safe owner's signing key. No Safe threshold change is required by the task.

## Deployment and governance scope

| Component                          | Action                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Temporary Create2Factory           | Deploy using ordinary CREATE; selected deployment wallet remains admin/deployer    |
| FundingRateFacet                   | Deploy through CREATE2 with suffix 863; replace its seven existing Core selectors  |
| LibQuoteFunding                    | Reuse `0x22900B12b1d439cd2D069B0E1Beee2669C7c8730`; verify its pinned runtime hash |
| Four rounding facets and libraries | Preserve the installed upgrade                                                     |
| Core and peripheral contracts      | Keep their existing addresses; no peripheral deployment                            |

`FundingRateFacetImpl` is internal code compiled into the facet. This patch requires no new library, ABI change, storage migration or initializer. It permits the effective bound and bindable PartyB to charge accumulated funding without Muon signature, timestamp and UPNL solvency checks. Quote ownership/status, symbol freeze, liquidation and pause guards and balance-debit checks remain. All other callers retain the signature and solvency checks.

The Safe's new pause roles remain assigned after completion. The initial role-grant calls are individually simulated from the Safe address and are independent of each other. Later exports depend on confirmed chain state: role grants before pause, pause before cut, and verified installation before unpause. An independent role holder can still change pause state after a file is exported; the file contains a normal Core call, so coordinate the maintenance window and keep Core paused through cut verification.

## Resume and evidence

Choose **Continue active task** in the same checkout. Confirmed deployments and publication records are reused. Each external action is recomputed from chain state before its step completes. The pending file's intent cannot be silently replaced with different calldata. If roles were partially granted outside the exported batch, complete the original reviewed grant batch before continuing; its repeated grants are idempotent.

If an operation fails after pausing, Core stays paused until an authorized unpause transaction succeeds. Cancelling the local task does not undo transactions or automatically unpause Core. Preserve its evidence before preparing a different run.

The task prints `tasks/data/42161/rounding-upgrades/<input-digest>/report.json` and the Safe file paths. Role, pause, cut and unpause deliveries are recorded at `rolesDelivery`, `pauseDelivery`, `safeDelivery` and `unpauseDelivery`. The report also records deployments, publication results, inspected selectors and block numbers for roles, pause, upgrade and unpause verification. Runtime parity and explorer publication are separate checks; both newly deployed contracts must pass both.

The baseline was reviewed at Arbitrum block **502618247**, hash `0xc8864c4a2eedbdd49b1fd94c2bd313f897f460433b3e26174f718114ecec6716`. All 464 selectors matched the completed rounding upgrade and all nine earlier deployment hashes matched their records. The old funding facet was `0x5A9b0b3eb9826EdA01fbFde0402C168e3a648af4`. The Dev Safe held default-admin authority but lacked both pause roles; all ten pause flags were false. These observations are a baseline, and the task repeats checks against live chain state.

Local regression tests exercise the two-contract deployment and recovery, funding-only cut, preserved getter/selectors, linked bytecode checks, missing-role exports, role/pause gating and four-file Safe resume flow. They use simulated accounts and do not prove a live deployment, hardware signing or explorer publication.
