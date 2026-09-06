# Arbitrum Vibe production rounding fix: version_0.8.6.2

This Core-only maintenance task upgrades `0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A` using its owner Ledger, `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`. It deploys and publishes nine contracts, pauses Core, verifies the pause, executes the diamond cut, verifies the installed upgrade while Core remains paused, and then unpauses Core.

The new recipe is [`deployment-recipes/arbitrum-vibe-production-862.json`](../deployment-recipes/arbitrum-vibe-production-862.json). The existing Core, Ledger owner, collateral, baseline facets and reused libraries are pinned in [`tasks/config/arbitrum-rounding-upgrade-vibe-production-42161.json`](../tasks/config/arbitrum-rounding-upgrade-vibe-production-42161.json). The earlier stage recipe and Safe workflow remain separate.

## Run through symmio

Use Node **22.15.0** and the prepared release checkout, which contains the tagged rounding-only Solidity and the updated operator scripts:

```bash
cd /home/home/Documents/Development/Symmio/perps-core/.releases/version_0.8.6.2
./symmio
```

1. Select **Other maintenance scripts** → **Arbitrum Vibe production rounding fix v0.8.6.2**.
2. Select the owner Ledger at `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`. Choose the derivation scheme that corresponds to this account on your device; the script checks the address. This owner pays Arbitrum ETH for the three governance transactions.
3. Select the contract deployment signer separately, for example **Hardhat keystore → TEAM_DEPLOYER**. This wallet pays for the nine deployments and receives `DEFAULT_ADMIN_ROLE` and `DEPLOYER_ROLE` on the new temporary factory. The recipe uses keystore references `RPC_ARBITRUM` and `ETHERSCAN_APIKEY`; enter passwords only in the operator's keystore prompt.
4. Review the target and scope. The script compiles, checks the live owner and its `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and `UNPAUSER_ROLE`, checks collateral and the pinned baseline, then asks for `UPGRADE VIBE PRODUCTION version_0.8.6.2 ON 42161`.
5. Let the deployment signer deploy the temporary factory, four libraries and four facets, and let the script publish all nine contracts on Arbiscan. Each new facet address ends in **862**. Core has not been paused by this task yet.
6. Review and confirm **`pauseGlobal()`** on the Ledger. The script waits for confirmation and reads Core's global pause flag before proceeding.
7. Review and confirm **`diamondCut(...)`** on the Ledger. The cut targets the same Core, sends zero ETH, replaces four facets, adds `liquidationStartPositionCount(address)`, removes no selectors and uses no initializer. The script verifies all selectors, linked runtime bytecode, the new getter and publication records while requiring Core to remain globally paused.
8. After verification succeeds, review and confirm **`unpauseGlobal()`** on the Ledger. Core becomes globally unpaused when this transaction executes. The task completes only after reading the cleared global flag from chain state.

These are three separate Ledger transactions. Core stays paused through the cut and its verification in the normal workflow. The script rechecks the pause immediately before requesting the cut signature; the contract itself does not atomically enforce pause-plus-cut. An independent authorized operator can still change pause state during the signing window. Coordinate the maintenance window accordingly.

The script skips a redundant pause if Core is already globally paused and skips a redundant unpause if the verified Core is already globally unpaused. Clearing the global flag preserves every other pause flag, so separately paused operations remain paused. No Safe Transaction Builder files are used for this Ledger-owned production Core.

## Deployment scope and address pattern

| Deployment               | Count | Method                                                   |
| ------------------------ | ----- | -------------------------------------------------------- |
| Temporary Create2Factory | 1     | Ordinary CREATE; deployment signer is admin and deployer |
| Rounding libraries       | 4     | Ordinary CREATE                                          |
| Rounding facets          | 4     | CREATE2; each address ends in 862                        |

The libraries are `LibPartyALiquidationLegacySetup`, `LibPartyALiquidationSnapshotSetup`, `LibPartyALiquidationProcess` and `ClearingHouseFacetImpl`. The facets are `PartyALiquidationFacet`, `PartyALiquidationSnapshotFacet`, `ClearingHouseFacet` and `ViewFacet`.

The task reuses production's `LibQuoteFunding` at `0x02D2cAd57ddF23c2eD371cC7C171796DcFF34f9A` and `LibQuoteClose` at `0x8C7B58951A6835690b402C12Ed1698F60D01E515`, with runtime hash checks. It does not require a deployment role on the old factory at `0x99B425BC19F99a1B922664c0E4fa8A0870CE9975`. The new factory's admin remains the selected deployment wallet after completion; Core's owner remains the Ledger.

The recipe sets `create2.groups.facets.suffix` to `862` and `create2.factory.mode` to `deploy`. Its generic system components have `mode: "skip"` because this named maintenance task deploys the explicit nine-contract scope. Run it from **Other maintenance scripts**; the recipe does not request a fresh Core Diamond or redeployment of AccountLayer, InstantLayer, GaslessLayer, ExpressProvider, Liquidator or other peripheral contracts.

The allowance remains **3 raw accounting units per position at liquidation start**. Larger reconciliation differences still dispute. Already-started liquidations and existing disputes are not backfilled or automatically resolved.

## Resume and evidence

If a transaction or verification fails, choose **Continue active task** in the same release checkout. Keep the signer selections, recipe and source unchanged. The deployment signer and Ledger owner have separate transaction checkpoints, so a governance receipt cannot be confused with a deployment receipt. Submitted transactions are reconciled before retrying, and confirmed deployments are reused. A failure after pausing leaves Core paused until a successful unpause transaction; cancelling a task does not undo chain effects.

If another operator unpauses Core before the cut or before its paused verification, the script refuses that step. Restore the required global pause before continuing. Do not change a bound recipe to bypass a resume error.

The task prints the run evidence and `tasks/data/42161/rounding-upgrades/<input-digest>/report.json` path. The report contains deployment addresses, deployment and governance transaction records, governance previews, selector inspection, pause checks and final unpause verification. Arbiscan publication and runtime parity are separate checks: all nine new contracts must have successful publication records and matching compiled runtime before completion. The two reused libraries are hash checked; this task does not certify explorer publication of every existing protocol implementation.

The production baseline was inspected at Arbitrum block **502343421**, hash `0xfa9dd26def20caec88ef90652cbc3c57cfa84a38b89aef0227c12002121e8769`. At that block the owner above had the three required roles, all ten pause flags were false, and the four old facets plus their six linked libraries matched the original `c335a539` baseline artifacts after linking and immutable normalization. The baseline had 463 selectors and no new rounding getter. These are preparation observations; the task repeats live checks before deployment and governance.

The annotated tag **version_0.8.6.2** remains on the last Solidity change, **`0eb4b51fdffd15d4d442a63593cdda7cd94873f4`**. Operator commits belong on `release/version_0.8.6.2`, with the same contracts tree. The run binds the separate Solidity tag commit, script commit, recipe digest and target digest. Checking out only the tag omits later script changes.

Local verification covers pause/cut/unpause behavior, refusal of an unpaused cut or wrong owner signer, preservation of other pause flags, deployment recovery, production/stage source isolation and the Ledger subprocess environment. Local tests use simulated accounts; they do not prove Ledger hardware connectivity, live transaction execution or live explorer publication. Preparing these files does not execute the production upgrade.
