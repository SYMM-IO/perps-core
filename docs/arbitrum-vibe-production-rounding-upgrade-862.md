# Arbitrum Vibe production rounding and funding fix: suffix 862

This Core-only maintenance task upgrades `0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A` using its owner Ledger, `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`. It deploys and publishes ten contracts for the rounding and bound-solver funding changes, executes one diamond-cut transaction, and verifies the installed upgrade. The production workflow preserves the existing pause flags and sends no pause or unpause transaction.

The new recipe is [`deployment-recipes/arbitrum-vibe-production-862.json`](../deployment-recipes/arbitrum-vibe-production-862.json). The existing Core, Ledger owner, collateral, baseline facets and reused libraries are pinned in [`tasks/config/arbitrum-rounding-upgrade-vibe-production-42161.json`](../tasks/config/arbitrum-rounding-upgrade-vibe-production-42161.json). The earlier stage recipe and Safe workflow remain separate.

## Run through symmio

Use Node **22.15.0** and the prepared release checkout, which contains Solidity tagged **version_0.8.6.2-funding** and the updated operator scripts. All new facet addresses still end in **862**:

```bash
cd /home/home/Documents/Development/Symmio/perps-core/.releases/version_0.8.6.2
./symmio
```

1. Select **Other maintenance scripts** → **Arbitrum Vibe production / Ledger rounding + funding v0.8.6.2**.
2. Select the contract deployment signer, for example **Hardhat keystore → TEAM_DEPLOYER**. This wallet pays for the ten deployments and receives `DEFAULT_ADMIN_ROLE` and `DEPLOYER_ROLE` on the new temporary factory. The recipe uses keystore references `RPC_ARBITRUM` and `ETHERSCAN_APIKEY`; enter passwords only in the operator's keystore prompt.
3. Review the target and scope. The script compiles, checks the live owner and its `DEFAULT_ADMIN_ROLE`, checks collateral and the pinned baseline, then asks for `UPGRADE VIBE PRODUCTION version_0.8.6.2-funding ON 42161`. Pause roles are not required for production.
4. Let the deployment signer deploy the temporary factory, four libraries and five facets, and let the script publish all ten contracts on Arbiscan. Each new facet address ends in **862**. Core has not been paused by this task yet.
5. After publication, choose **Wait for admin** to save progress, or **Connect Ledger and continue**. Only then does the script ask for the owner Ledger at `0x77A955776Ee1dd3E9C800c3214ed489441d74b94`. Choose the derivation scheme that corresponds to this account on the admin's device; the script checks the address. This owner pays Arbitrum ETH for the single governance transaction.
6. Review and confirm **`diamondCut(...)`** on the Ledger. The cut targets the same Core, sends zero ETH, replaces five facets including all seven FundingRateFacet selectors, adds `liquidationStartPositionCount(address)`, removes no selectors and uses no initializer. The script checks publication and runtime before signing and simulates the exact call from the owner.
7. After confirmation, the script verifies all selectors, linked runtime bytecode, the new getter and publication records. It records the final pause flags and completes. There is no subsequent signing step.

The seven-step production task does not pause trading. If Core was already paused independently, the upgrade leaves it paused. Stage's separate Safe funding workflow still includes pause and unpause. No Safe Transaction Builder files are used for this Ledger-owned production Core.

## Deployment scope and address pattern

| Deployment                  | Count | Method                                                   |
| --------------------------- | ----- | -------------------------------------------------------- |
| Temporary Create2Factory    | 1     | Ordinary CREATE; deployment signer is admin and deployer |
| Rounding libraries          | 4     | Ordinary CREATE                                          |
| Rounding and funding facets | 5     | CREATE2; each address ends in 862                        |

The libraries are `LibPartyALiquidationLegacySetup`, `LibPartyALiquidationSnapshotSetup`, `LibPartyALiquidationProcess` and `ClearingHouseFacetImpl`. The facets are `PartyALiquidationFacet`, `PartyALiquidationSnapshotFacet`, `ClearingHouseFacet`, `ViewFacet` and `FundingRateFacet`. The funding facet links the existing `LibQuoteFunding`; `FundingRateFacetImpl` is internal code compiled into the facet and requires no separate deployment.

The task reuses production's `LibQuoteFunding` at `0x02D2cAd57ddF23c2eD371cC7C171796DcFF34f9A` and `LibQuoteClose` at `0x8C7B58951A6835690b402C12Ed1698F60D01E515`, with runtime hash checks. It does not require a deployment role on the old factory at `0x99B425BC19F99a1B922664c0E4fa8A0870CE9975`. The new factory's admin remains the selected deployment wallet after completion; Core's owner remains the Ledger.

The recipe sets `create2.groups.facets.suffix` to `862` and `create2.factory.mode` to `deploy`. Its generic system components have `mode: "skip"` because this named maintenance task deploys the explicit ten-contract scope from the production profile. Run it from **Other maintenance scripts**; the recipe does not request a fresh Core Diamond or redeployment of AccountLayer, InstantLayer, GaslessLayer, ExpressProvider, Liquidator or other peripheral contracts.

The allowance remains **3 raw accounting units per position at liquidation start**. Larger reconciliation differences still dispute. Already-started liquidations and existing disputes are not backfilled or automatically resolved.

The funding change skips Muon signature verification, signature freshness and both parties' UPNL-based solvency checks in `chargeAccumulatedFundingFee()` only when the effective caller equals PartyB, PartyA is bound to that PartyB, and PartyB remains bindable. Pending unbind retains the binding until completion. Other callers retain the checks. Quote ownership/status, symbol freeze, liquidation and pause guards and balance-debit checks still apply. Funding calculations, ABI and storage layout are unchanged. Eligible bound calls can supply an empty signature tuple; solver integrations must keep signed calls for other paths.

## Resume and evidence

If the Ledger is unavailable at the cut boundary, choose **Wait for admin**. Cancelling Ledger selection also waits safely. The task waits with the ten deployments and publication evidence preserved; the admin can connect the Ledger later and choose **Continue active task**. After the Ledger is selected, its public address and derivation are bound to the task. If a transaction or verification fails, choose **Continue active task** in the same release checkout. Keep the deployment signer and recipe unchanged. The deployment signer and Ledger owner have separate transaction checkpoints, so a governance receipt cannot be confused with a deployment receipt. Submitted transactions are reconciled before retrying, and confirmed deployments are reused. Cancelling a task does not undo chain effects.

For an existing eleven-step production run waiting after publication, select **Wait for admin**, then **Exit** in the old process. Restart `./symmio` from the updated release checkout and choose **Continue active task**. The runner displays a `MIGRATE <source-hash-prefix>` confirmation because this run is pinned to its former scripts. Enter the displayed phrase to authorize the reviewed script update. The task replaces the pending pause/cut/unpause plan with cut and verification, preserving the five completed steps, ten deployment transactions, addresses, publication records, original input digest and deployment checkpoint. Its migration journal retains the original plan.

This migration is accepted only after all ten deployments are confirmed and published and before governance actions have started. Unresolved transactions, an altered recipe or target, Solidity changes, unsupported tooling changes, or a run that already recorded pause/governance activity are rejected. The Solidity tag and facet suffix remain unchanged. The supported migration keeps task version 3 and input API v5 so the existing deployed run can resume without recreating its deployment input.

The task prints the run evidence and `tasks/data/42161/rounding-upgrades/<input-digest>/report.json` path. The report contains deployment addresses, deployment and governance transaction records, the cut preview, selector inspection and `finalPauseState`. Arbiscan publication and runtime parity are separate checks: all ten new contracts must have successful publication records and matching compiled runtime before completion. Missing FundingRateFacet publication blocks governance and final verification. The two reused libraries are hash checked; this task does not certify explorer publication of every existing protocol implementation.

The production baseline was inspected at Arbitrum block **502343421**, hash `0xfa9dd26def20caec88ef90652cbc3c57cfa84a38b89aef0227c12002121e8769`. At that block the owner above had the three required roles, all ten pause flags were false, and the four old facets plus their six linked libraries matched the original `c335a539` baseline artifacts after linking and immutable normalization. The baseline had 463 selectors and no new rounding getter. These are preparation observations; the task repeats live checks before deployment and governance.

The additional FundingRateFacet baseline was checked at block **502603420**, hash `0xdd6d2e07cd472f630160346c8e952bcb09cf554a1b6d567a7e4dbcc5ac2b27a1`. All seven selectors mapped to `0xC84de9c1EB96545d99Eb7FeEF85AaA8D6A893861`, whose runtime matched the original baseline artifact. Accumulated funding was enabled and Enigma was registered and bindable; a trader's individual binding still determines eligibility.

The production source tag **version_0.8.6.2-funding** points to the final Solidity change, **`9607ae6e17bc46f734a62e4b5028caf6eecae3ef`**. It contains the rounding release plus the isolated funding patch, with contracts tree `110017b11256bfa472210c81d6e01b266e97a452`. The original stage tag **version_0.8.6.2** remains at `0eb4b51fdffd15d4d442a63593cdda7cd94873f4`. The stage profile retains its original four-facet scope and requires a checkout with its original tagged contracts. Operator commits follow the production Solidity commit on `release/version_0.8.6.2`. The run binds the Solidity tag commit, script commit, recipe digest and target digest. Checking out only the tag omits later script changes.

The expanded production task uses input API v5 and task version 3. A prepared rounding-only input cannot resume as this combined upgrade: its source and input bindings must remain intact. Start the combined task with a fresh input after closing any older unexecuted task through the operator menu; preserve any prior transaction evidence.

Local verification covers the production cut without pause roles, rejection of production pause/unpause phases or a wrong owner signer, preservation of pause flags, deployment recovery, confirmed migration of the published run, production/stage source isolation and the Ledger subprocess environment. Stage pause requirements remain covered separately. Local tests use simulated accounts; they do not prove Ledger hardware connectivity, live transaction execution or live explorer publication. Preparing these files does not execute the production upgrade.
