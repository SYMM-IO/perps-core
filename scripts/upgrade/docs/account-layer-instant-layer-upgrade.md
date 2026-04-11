# AccountLayer + InstantLayer in the Upgrade Process

This doc explains what was added to the upgrade scripts, why, and how it all fits together.

## Why This Was Needed

AccountLayer and InstantLayer are **entirely new in v0.8.5** -- they don't exist in v0.8.4. The upgrade scripts previously only handled the core diamond facet swap (diamondCut) and parameter setting. They were missing the deployment and wiring of these two new contracts.

## What Was Added

### New file: `scripts/upgrade/utils/peripheralHelpers.ts`

Contains 5 exported functions:

#### `deployAccountLayerDiamond(adminAddress, symmioFeeReceiver, stateFile?)`

Deploys the AccountLayer Diamond from scratch:

1. **DiamondCutFacet** -- same contract as core diamond but a separate instance
2. **Diamond proxy** -- constructor args: `(admin, diamondCutFacetAddress)`
3. **Init contract** -- `contracts/accountLayer/Init.sol:Init`
4. **LibQuoteParams library** -- needed by CoreFacet
5. **7 facets:**
   - CoreFacet (linked to LibQuoteParams)
   - MarginFacet
   - SymmioHookFacet
   - ControlFacet
   - ViewFacet
   - AffiliateFacet
   - DiamondLoupeFacet
6. **Diamond cut** -- adds all 7 facets in chunks of 3. The first chunk includes the Init call: `init(admin, symmioFeeReceiver, accountManagerBytecode)`. The AccountManager bytecode is read from `contracts/accountLayer/AccountManager.sol:AccountManager` -- it's stored in the diamond for later CREATE2 deployment when affiliates register.

The Init grants the admin: `DEFAULT_ADMIN_ROLE`, `SETTER_ROLE`, `APPROVER_ROLE`, `PAUSER_ROLE`, `UNPAUSER_ROLE`.

Resume-safe via `stateFile` -- each deployed contract is saved immediately. If the script crashes mid-way, re-running picks up from where it left off.

#### `deployInstantLayer(symmioAddress, adminAddress, stateFile?)`

Deploys a single `InstantLayer` contract. Constructor args: `(symmioAddress, admin)`. The constructor grants admin `DEFAULT_ADMIN_ROLE` and `SETTER_ROLE`.

#### `wireAccountLayerInstantLayer(diamondAddress, alDiamondAddress, ilAddress, adminSigner)`

Executes all the integration wiring. This is the critical part -- without this, the contracts exist but can't talk to each other.

**On core Diamond (via ControlFacet):**
- `grantRole(admin, INTEGRATION_ADMIN_ROLE)` -- needed for registerHook
- `grantRole(accountLayer, SIGNER_ADMIN_ROLE)` -- AL can manage signers
- `grantRole(accountLayer, AFFILIATE_MANAGER_ROLE)` -- AL can manage affiliates
- `grantRole(accountLayer, BALANCE_SETTLER_ROLE)` -- AL can settle balances
- `grantRole(instantLayer, INSTANT_LAYER_ROLE)` -- IL can set instant layer mode
- `registerHook(address(0), accountLayer)` -- registers AL as system hook for all quotes (address(0) = global hook)

**On AccountLayer Diamond (via its ControlFacet):**
- `grantRole(instantLayer, SIGNER_SETTER_ROLE)` -- IL can call setSigner during operation execution
- `setWhitelistedSymmioCore(diamond, true)` -- affiliates can only register with whitelisted cores

**On InstantLayer:**
- `setAccountLayer(accountLayer)` -- IL knows where AL lives
- `setTargetWhitelist(diamond, true)` -- operations can call diamond
- `setTargetWhitelist(accountLayer, true)` -- operations can call AL

#### `setupInstantLayerTemplates(ilAddress, adminSigner)`

Adds three templates:

**InstantOpen (4 ops):**
```
0. addMarginToNextVA                 -> no injection
1. sendQuote                         -> returns quoteId
2. lockQuote(quoteId, sig)           -> quoteId piped from op 1
3. openPosition(quoteId, ...)        -> quoteId piped from op 1
```

**InstantClose (2 ops):**
```
0. requestToClosePosition(quoteId, ...)
1. fillCloseRequest(quoteId, ...)
```

**InstantCloseWithAllocation (3 ops):**
```
0. (independent)
1. (independent)
2. (independent)
```

The piping is defined by `sourceIndices`, `insertionPoints`, and `sourceOffsets` arrays on each operation. These tell InstantLayer which return value from which previous operation to inject into which calldata offset.

#### `buildWiringTransactions(diamondAddress, alDiamondAddress, ilAddress, adminAddress, symmioPartyBAddress?, symmioPartyBImplementation?)`

For the Safe path. Returns an array of `{ to, value, calldata, description }` objects -- the same wiring as `wireAccountLayerInstantLayer` but as raw calldata instead of executed transactions. These get appended to the Safe batch JSON.

If `symmioPartyBAddress` is provided, also generates `registerPartyBs([symmioPartyB])` on InstantLayer.

Note: each transaction targets a different contract (`to` varies between diamond, AL, IL, and PartyB proxy admin), which the Safe Transaction Builder handles fine.

## How It Integrates Into Each Script

### `forkUpgrade.ts` (fork rehearsal)

New step 9 between "set v0.8.5 parameters" and "verify upgrade":

1. Reads `symmioFeeReceiver` from config (defaults to admin address)
2. Deploys AL diamond using `signers[0]` (anyone can deploy)
3. Deploys IL using `signers[0]`
4. Wires everything using the impersonated admin signer
5. Sets up templates (unless `setupInstantLayerTemplates: false`)
6. Saves addresses to `output/deployed-accountlayer-instantlayer.json`

The impersonated admin is used for wiring because only the diamond owner can call `grantRole` and `registerHook` on the core diamond.

### `eoaUpgrade.ts` (EOA production)

New step 6 (migration role grant moved to step 7):

Same as fork but uses the connected EOA signer for both deployment and wiring.

### `generateSafeBatch.ts` (Safe multisig)

For Safe, the contracts must be deployed separately first (Safe can't deploy contracts). Once deployed, set these in config:

```json
{
  "accountLayerDiamondAddress": "0x...",
  "instantLayerAddress": "0x..."
}
```

If both are set, `buildWiringTransactions()` generates calldata and appends it to `safe-batch.json`. If not set, the script warns and skips.

## Other Changes

### `upgradeHelpers.ts` -- `setV085Parameters` signer fix

Added optional `signerOverride` parameter. Previously it always used `ethers.provider.getSigner()` which returns `signers[0]` -- fine for EOA path but wrong for fork path where the admin is an impersonated signer. Now `forkUpgrade.ts` passes the impersonated admin.

This also fixed the **parameter gap** -- `forkUpgrade.ts` previously had an inline implementation that only handled 3 of 9 parameters (maxPartyAConnectionLimit, settlementCooldown, deallocateDebounceTime). Now it uses the shared `setV085Parameters` which handles all 9:
- maxPartyAConnectionLimit
- signatureVerifierAddress
- liquidationInsuranceVault + maxLiquidationProfitPerPosition
- softLiquidationPenaltyCollector
- minAffiliateFee
- unbindCooldown
- maxWithdrawParts
- minWithdrawCooldown

### Config additions

New fields in `upgrade.json`:

| Field | Used by | Purpose |
|-------|---------|---------|
| `symmioFeeReceiver` | fork, EOA | Fee receiver address for AccountLayer Init. Defaults to admin. |
| `setupInstantLayerTemplates` | fork, EOA | Whether to add OpenPosition/ClosePosition templates. Default: true. |
| `accountLayerDiamondAddress` | Safe | Pre-deployed AccountLayer address for wiring. |
| `instantLayerAddress` | Safe | Pre-deployed InstantLayer address for wiring. |

## Execution Order

The full fork rehearsal flow is now:

```
1. Verify RPC
2. Validate inputs
3. Impersonate admin
4. Fetch subgraph data (pre-upgrade reference)
5. Capture pre-upgrade snapshot (quote + balance spot-check)
6. Pause system
7. Deploy v0.8.5 core diamond facets
8. Build + apply diamondCut (chunked)
9. Set v0.8.5 parameters (all 9)
10. Deploy AccountLayer Diamond (7 facets + init)    <-- NEW
11. Deploy InstantLayer                               <-- NEW
12. Wire AL + IL to core Diamond                      <-- NEW
13. Setup InstantLayer templates                      <-- NEW
14. Verify upgrade integrity (pre vs post snapshot)
15. Grant MIGRATION_ROLE
--- then separately ---
16. prepareMigrationInput.ts
17. runMigration.ts
18. generatePostMigrationBatch.ts (unpause + enable cross mode)
```

## SymmioPartyB Handling

The v0.8.5 SymmioPartyB adds ERC-1271 (`isValidSignature`) support required by InstantLayer. The storage layout is compatible with v0.8.4 for in-place proxy upgrades.

- `deployPeripherals.ts` deploys the new SymmioPartyB implementation (not the proxy)
- `generateSafeBatch.ts` generates UUPS proxy upgrade + InstantLayer registration transactions when `symmioPartyBAddress` and `symmioPartyBImplementation` are set in config
- `testTemplateExecution.ts` verifies the full flow end-to-end (deploy PartyB, register, fund, execute InstantOpen template)

## Things NOT Handled

These are intentionally left out of the upgrade scripts:

- **Dummy affiliate registration** -- only needed for testing, not production upgrades.
- **AccountManager deployment** -- happens automatically via CREATE2 when an affiliate registers through AccountLayer. The bytecode is stored during Init.
- **Diamond ownership transfer** -- the upgrade doesn't change ownership.
