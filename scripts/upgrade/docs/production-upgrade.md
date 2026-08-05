# Production Upgrade (v0.8.4 -> v0.8.5)

## Overview

The production upgrade flow depends on whether the diamond is owned by an EOA or a multisig (Gnosis Safe). In both paths, all contract deployments happen **before** the system is paused to minimize downtime.

## Safe Path (Production)

There are two variants depending on whether the diamond is owned directly by the Safe or by a TimeLock contract (which is itself owned by the Safe). The timelock variant schedules the diamondCut **before** pausing, so the timelock delay passes while the system is still live -- minimizing downtime.

### Safe Path: Direct (Safe owns diamond)

```
READ MUON CONFIG (one-time, if upgrading from v0.8.4)
═════════════════════════════════════════════════════
  Reads TSS public key + gateway signer from the v0.8.4 diamond.
  Paste output into upgrade.json → newV085Parameters.

  readMuonConfig.ts → muon-config.json + console snippet

BEFORE PAUSE (no downtime)
══════════════════════════

 deployFacets.ts                deployPeripherals.ts
 (deploy libs + facets)         (deploy SigVerifier + AL + IL + PartyB impl
        │                        + SymbolManager + transferOwnership(Safe)
        │                        on AccountLayer)
        ▼                              │
 deployed-facets-{network}.json          deployed-peripherals-{network}.json
        │                              │
        └──────────┬───────────────────┘
                   ▼
         fetchSolverList.ts
         (writes partyBList-{network}.json from subgraph Solver entities)
                   │
                   ▼
         generateSafeBatch.ts
         (reads deployments + partyBList, no on-chain actions)
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
  safe-batch.json    diamondcut-calldata.json


VERIFY DEPLOYED BYTECODE (local vs on-chain)
═════════════════════════════════════════════
  NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyCoreBytecode.ts
  NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts

  Compares on-chain bytecode against locally compiled artifacts.
  Handles library linking (core facets) and immutable variables (peripherals).
  NETWORK resolves the correct file (e.g. deployed-facets-arbitrum.json).

VERIFY GENERATED CALLDATA (local repo vs on-disk JSON)
═══════════════════════════════════════════════════════
  npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network <network>

  Reconstructs each batch from current upgrade.json + deployed-*.json and
  byte-compares against pause-safe-batch / safe-batch / diamondcut-calldata
  / timelock-{schedule,execute} / post-migration / symbol-role / add-templates
  JSON files. Run before signing anything in the Safe UI.

VERIFY DEPLOYED CONTRACTS (block explorer source + ABI)
═════════════════════════════════════════════════════════
  USE_KEYSTORE=true npx hardhat run scripts/upgrade/verifyBlockExplorer.ts --network <network>

  Publishes/verifies source + ABI for all libraries, facets, and peripherals
  (AL, IL, PartyB impl, SymbolManager) on the block explorer. This is separate
  from bytecode parity and final wiring/state verification.


PAUSE (execute via Safe UI)
══════════════════════════
  pause-safe-batch.json:
    1. grantRole(PAUSER_ROLE)
    2. grantRole(UNPAUSER_ROLE)
    3. pauseGlobal()              <-- PAUSE

DIAMONDCUT (execute via Safe UI)
════════════════════════════════
  diamondcut-calldata.json:
    diamondCut (executed as separate Safe tx)

POST-DIAMONDCUT (execute via Safe UI)
═════════════════════════════════════
  safe-batch.json contains:
    1. grantRole(PROTOCOL_CONFIG / COOLDOWN_ADMIN / FEE_ADMIN)
    2. set v0.8.5 parameters
    3. grantRole(MIGRATION_ROLE)
    4. [wiring] AL/IL roles + hooks + whitelist
    5. [wiring] SymbolManager roles (SYMBOL_MANAGER_ROLE + FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE)
    6. [wiring] registerPartyB on Diamond + registerPartyBs on IL (from config/partyBList-{network}.json; each target gated by registerOnSymmioCore / registerOnInstantLayer, pre-filtered vs on-chain state)
    7. [ownership] acceptOwnership() on AccountLayer diamond
       (transferOwnership was already called by deployer during deployPeripherals)


PREPARE MIGRATION + SYMBOL INPUTS (before pause — version-agnostic)
═══════════════════════════════════════════════════════════════════
  prepareMigrationInput.ts       (subgraph + boundary check — version-agnostic)
  validateMigrationInput.ts      (optional — random spot-check)
  validateMigrationEdgeCases.ts  (optional — boundary, fork drift, gap scan)
  fetchSymbolList.ts             (symbol input for setSymbolType.ts)


RUN MIGRATION (after diamondCut — requires v0.8.5)
═══════════════════════════════════════════════════

 runMigration.ts                (migrateQuotes + migrateCrossLocked + verify)
        │
        ▼
 migration-report.json

 setSymbolType.ts               (backfill symbolType for all symbols)
 whitelistSymbolTypes.ts        (whitelist symbol type per PartyB)


UNPAUSE
═══════

 generatePostMigrationBatch.ts  (generates calldata, no on-chain)
        │
        ▼
  Execute via Safe UI:
    1. unpauseGlobal()            <-- UNPAUSE
    2. setCrossPartyBModeActivated(true)
    3. setCrossPartyB(partyB, true) x N


POST-UPGRADE PATCHES (if needed after unpause)
═══════════════════════════════════════════════
  generateSymbolTypeRoleBatch.ts   (grant/revoke SYMBOL_MANAGER_ROLE via Safe)
  generateTemplateBatch.ts         (add InstantLayer templates via Safe)
  whitelistSymbolTypes.ts          (whitelist symbol type per PartyB)
```

### Safe Path: TimeLock (TimeLock owns diamond, Safe owns TimeLock)

When the diamond is behind a timelock, the diamondCut must be scheduled first and
executed after the delay. The key optimization: schedule the diamondCut **while the
system is still live**, wait for the delay to pass (no downtime), then pause + execute
the cut + migrate + unpause in a single maintenance window.

```
BEFORE PAUSE (no downtime)
══════════════════════════

 deployFacets.ts                deployPeripherals.ts
 (deploy libs + facets)         (deploy SigVerifier + AL + IL + PartyB impl
        │                        + SymbolManager + transferOwnership(Safe)
        │                        on AccountLayer)
        ▼                              │
 deployed-facets-{network}.json          deployed-peripherals-{network}.json
        │                              │
        └──────────┬───────────────────┘
                   ▼
         fetchSolverList.ts
         (writes partyBList-{network}.json from subgraph Solver entities)
                   │
                   ▼
         generateSafeBatch.ts
         (reads deployments + partyBList, no on-chain actions)
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
  safe-batch.json    diamondcut-calldata.json
                              │
                              ▼
                    generateTimelockBatch.ts
                    (wraps diamondCut for timelock)
                              │
                    ┌─────────┴──────────────┐
                    ▼                        ▼
  timelock-schedule-safe-batch.json   timelock-execute-safe-batch.json


VERIFY DEPLOYED BYTECODE (local vs on-chain)
═════════════════════════════════════════════
  NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyCoreBytecode.ts
  NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts

VERIFY GENERATED CALLDATA (local repo vs on-disk JSON)
═══════════════════════════════════════════════════════
  npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network <network>

  Also checks timelock-{schedule,execute}-safe-batch-*.json: inner calldata
  matches diamondcut-calldata chunks, predecessor chain and salt derivation
  are correct.

VERIFY DEPLOYED CONTRACTS (block explorer)
═══════════════════════════════════════════
  USE_KEYSTORE=true npx hardhat run scripts/upgrade/verifyBlockExplorer.ts --network <network>


SCHEDULE DIAMONDCUT (T=0, system still live)
════════════════════════════════════════════
  Import timelock-schedule-safe-batch.json into Safe TX Builder
  Execute from Safe → calls timelock.schedule()
  Timer starts (e.g. 12 hours)


  ... timelock delay passes, system is still running normally ...


PAUSE (T=delay, downtime starts)
════════════════════════════════
  Import pause-safe-batch.json into Safe TX Builder
  Execute from Safe:
    1. grantRole(PAUSER_ROLE)
    2. grantRole(UNPAUSER_ROLE)
    3. pauseGlobal()              <-- PAUSE


EXECUTE DIAMONDCUT (T=delay, after pause)
═════════════════════════════════════════
  Import timelock-execute-safe-batch.json into Safe TX Builder
  Execute from Safe → calls timelock.execute()
  Diamond is now upgraded to v0.8.5


POST-DIAMONDCUT (T=delay, after diamondCut)
═══════════════════════════════════════════
  Import safe-batch.json into Safe TX Builder
  Execute from Safe:
    1. grantRole(PROTOCOL_CONFIG / COOLDOWN_ADMIN / FEE_ADMIN)
    2. set v0.8.5 parameters
    3. grantRole(MIGRATION_ROLE)
    4. [wiring] AL/IL roles + hooks + whitelist
    5. [wiring] SymbolManager roles (SYMBOL_MANAGER_ROLE + FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE)
    6. [wiring] registerPartyB on Diamond + registerPartyBs on IL (from config/partyBList-{network}.json; each target gated by registerOnSymmioCore / registerOnInstantLayer, pre-filtered vs on-chain state)
    7. [ownership] acceptOwnership() on AccountLayer diamond
       (transferOwnership was already called by deployer during deployPeripherals)


VERIFY
══════
  verifyDiamondSelectors.ts
  verifyPeripheralWiring.ts


PREPARE MIGRATION + SYMBOL INPUTS (before pause — version-agnostic)
═══════════════════════════════════════════════════════════════════
  prepareMigrationInput.ts       (subgraph + boundary check — version-agnostic)
        │
        ▼
  migration-input.json

  validateMigrationInput.ts      (optional — random spot-check)
  validateMigrationEdgeCases.ts  (optional — boundary, fork drift, gap scan)
  fetchSymbolList.ts             (writes symbol-types input for setSymbolType.ts)


RUN MIGRATION (after diamondCut — requires v0.8.5)
═══════════════════════════════════════════════════

 runMigration.ts                (migrateQuotes + migrateCrossLocked + verify)
        │
        ▼
 migration-report.json

 setSymbolType.ts               (backfill symbolType for all symbols)
 whitelistSymbolTypes.ts        (whitelist symbol type per PartyB)


UNPAUSE
═══════

 generatePostMigrationBatch.ts  (generates calldata, no on-chain)
        │
        ▼
  Execute via Safe UI:
    1. unpauseGlobal()            <-- UNPAUSE
    2. setCrossPartyBModeActivated(true)
    3. setCrossPartyB(partyB, true) x N


POST-UPGRADE PATCHES (if needed after unpause)
═══════════════════════════════════════════════
  generateSymbolTypeRoleBatch.ts   (grant/revoke SYMBOL_MANAGER_ROLE via Safe)
  generateTemplateBatch.ts         (add InstantLayer templates via Safe)
  whitelistSymbolTypes.ts          (whitelist symbol type per PartyB)


TIMELINE
════════

  T=0          Schedule diamondCut on timelock
               (system still running normally)

  T=delay      Execute pause-safe-batch.json (pause)
               Execute timelock diamondCut
               Execute safe-batch.json (roles + params + wiring + accept AL ownership)
               Verify upgrade
               Prepare migration input
               Run migration
               Execute post-migration batch (unpause)

  Minimum downtime = time between pause and unpause.
  The timelock delay passes with zero downtime.
  Migration input is prepared before the diamondCut to save time.
```

## EOA Path

**Pre-requisites (if upgrading from v0.8.4):** Run `readMuonConfig.ts` to capture TSS key + gateway (see [Read Muon Config](#read-muon-config-from-v084-diamond)). The `MuonSignatureVerifier` is deployed automatically by `deployPeripherals.ts` and the EOA path seeds it from `muonPublicKeys`/`muonGatewaySigners`, then configures `muonFunctionPermissions` for those keys and gateways.

### EOA Admin Model

For an EOA-owned diamond, keep these actors separate:

| Actor                      | Config field                     | Purpose                                                                                                                                     |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Permanent admin / owner    | `protocolAdmin`                  | Current v0.8.4 diamond owner and the only address that should retain `DEFAULT_ADMIN_ROLE` after cleanup. This can be a hardware wallet.     |
| Temporary upgrade executor | `upgradeOperator`                | Hot or operational address used for scoped upgrade work. It should receive only temporary roles and should not retain `DEFAULT_ADMIN_ROLE`. |
| Migration executor         | `migrationRunner`                | Address that runs `runMigration.ts`. Usually the same as `upgradeOperator`, but can be separate.                                            |
| Deployment payer           | `TEAM_DEPLOYER` / default signer | Address that pays for pre-pause deployments. It does not need ownership or protocol roles.                                                  |

`protocolAdmin` must perform owner/default-admin-only actions:

- `diamondCut()`
- accepting AccountLayer ownership after deployment
- granting temporary operator roles (`operator-grant`)
- removing the temporary operator `DEFAULT_ADMIN_ROLE` grants (`operator-admin-revoke`)
- final cleanup verification

`upgradeOperator` can perform scoped work after `operator-grant`:

- pause/unpause with `PAUSER_ROLE` / `UNPAUSER_ROLE`
- v0.8.5 parameter setup, including Muon verifier seeding, while it temporarily holds `DEFAULT_ADMIN_ROLE`
- AccountLayer / InstantLayer / SymbolManager wiring
- PartyB registration
- migration role grants, migration, and post-migration symbol updates
- migration/symbol role revokes and non-admin operator cleanup (`migration-revoke`, `symbol-revoke`, `operator-revoke`)

End state requirement: `upgradeOperator` and `migrationRunner` should have no temporary roles left. Only `protocolAdmin` should retain `DEFAULT_ADMIN_ROLE`.

### Hardware Wallet Signers

When the `protocolAdmin`, `upgradeOperator`, or `migrationRunner` is a hardware wallet, signer resolution always matches the configured address first. You do not need to know the account index upfront.

To inspect the accounts exposed by a wallet bridge:

```bash
HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> \
  npx hardhat run scripts/upgrade/listHardwareWalletAccounts.ts --network coti
```

To scan a Ledger directly when the derivation path is unknown:

```bash
HW_WALLET=ledger LEDGER_SCAN=true \
  npx hardhat run scripts/upgrade/listHardwareWalletAccounts.ts --network coti
```

Once a path is known, pin it in a shared non-secret Ledger config so every Ledger-aware script can reuse it without scanning:

```bash
cp scripts/upgrade/config/samples/ledger.sample.json scripts/upgrade/config/ledger-<network>.json
```

Set the discovered `address` and `path` under `accounts`. The signer helper reads `ledger-<network>.json` first, then `ledger.json`; env overrides such as `LEDGER_PATH` and role-specific `PROTOCOL_ADMIN_LEDGER_PATH` still take precedence. For a non-admin signer, use `HARDWARE_ROLE=upgradeOperator` or `HARDWARE_ROLE=migrationRunner` during discovery so it compares against that config field.

**Single script:**

1. **Upgrade** (`eoaUpgrade.ts`) -- deploy facets, pause, diamondCut, set params, deploy AL + IL + SymbolManager, wire, grant migration role
2. **Prepare migration input** (`prepareMigrationInput.ts`)
3. **Run migration** (`runMigration.ts`)
4. **Post-migration** (`eoaUpgrade.ts` post stages, or `generatePostMigrationBatch.ts` for Safe calldata) -- unpause, optionally enable cross-PartyB mode, then revoke temporary migration/symbol roles

Use this only when the connected signer is allowed to perform all privileged actions. For the two-admin model, prefer the staged flow below.

**Step-by-step:**

1. **Deploy only** (`UPGRADE_STAGES=deploy`) -- any deployer can pay gas before pause. Deployed peripherals are initialized with `protocolAdmin`; `newV085Parameters.signatureVerifierAddress` is written back to `upgrade-{network}.json`.
2. **Accept AccountLayer ownership** (`acceptAccountLayerOwnership.ts`) -- run with `protocolAdmin`.
3. **Validate and verify deployed contracts before pause** -- run bytecode verification for core facets and peripherals, then block-explorer verification for all deployed libraries/facets/peripherals.
4. **Bootstrap temporary roles** (`UPGRADE_STAGES=operator-grant`) -- `protocolAdmin` grants temporary core/peripheral roles to `upgradeOperator` and migration/symbol roles to `migrationRunner`.
5. **Pause with operator** (`UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=pause`) -- operator pauses before the migration/symbol snapshots are prepared.
6. **Prepare migration and symbol inputs after pause** -- run `prepareMigrationInput.ts`, validators, and `fetchSymbolList.ts` against paused state. This makes the inputs stable before migration. `prepareMigrationInput.ts` checkpoints completed open-quote pages, so a failed subgraph fetch resumes from the last saved globalCounter cursor.
7. **Apply diamondCut with owner** (`UPGRADE_STAGES=cut`) -- `protocolAdmin` runs the owner-only diamond cut. This cannot be delegated by role.
8. **Operator setup** (`UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=params,wiring,partyb,migration`) -- operator sets v0.8.5 params, seeds Muon verifier, wires peripherals, registers PartyBs, and grants migration role.
9. **Migration and symbol update** -- `runMigration.ts`, then `setSymbolType.ts` and `whitelistSymbolTypes.ts` with the paused-state input files.
10. **Unpause** (`UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=unpause`) -- unpause immediately after migration and symbol whitelisting, while `upgradeOperator` still has `UNPAUSER_ROLE`.
11. **Optional cross-mode** (`UPGRADE_SIGNER_ROLE=migrationRunner UPGRADE_STAGES=cross-mode,cross-partyb`) -- enable only if this deployment is ready for cross-PartyB mode; run before `MIGRATION_ROLE` is revoked.
12. **Revoke migration/symbol roles** -- `upgradeOperator`, while still holding temporary `DEFAULT_ADMIN_ROLE`, revokes temporary `MIGRATION_ROLE` and `SYMBOL_MANAGER_ROLE` from `migrationRunner`.
13. **Operator non-admin cleanup** (`UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=operator-revoke`) -- `upgradeOperator` revokes its own temporary non-admin roles.
14. **Operator admin cleanup** (`UPGRADE_STAGES=operator-admin-revoke`) -- `protocolAdmin` revokes the temporary `DEFAULT_ADMIN_ROLE` grants from `upgradeOperator`.
15. **Verify** -- run `checkOwners.ts` and role-specific checks; only `protocolAdmin` should retain permanent admin roles.

**EOA operator path commands:**

```bash
# 1. Deploy with any funded deployer. No protocolAdmin signer required.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_STAGES=deploy \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 2. Accept AccountLayer ownership with protocolAdmin.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> \
npx hardhat run scripts/upgrade/acceptAccountLayerOwnership.ts --network coti

# 3. Validate deployed bytecode and verify deployed contracts before pause.
NETWORK=coti RPC_URL=https://mainnet.coti.io/rpc \
npx ts-node scripts/upgrade/verifyCoreBytecode.ts

NETWORK=coti RPC_URL=https://mainnet.coti.io/rpc \
npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
npx hardhat run scripts/upgrade/verifyBlockExplorer.ts --network coti

# 4. Grant temporary operator roles with protocolAdmin.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> \
UPGRADE_STAGES=operator-grant \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 5. Pause with upgradeOperator.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=pause \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 6. Prepare migration + symbol inputs after pause.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
npx hardhat run scripts/upgrade/validateMigrationInput.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
npx hardhat run scripts/upgrade/validateMigrationEdgeCases.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
npx hardhat run scripts/upgrade/fetchSymbolList.ts --network coti

# 7. Apply owner-only diamondCut with protocolAdmin.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> \
UPGRADE_STAGES=cut \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 8. Finish role-based setup with upgradeOperator.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=params,wiring,partyb,migration \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 9. Run migration and symbol updates with migrationRunner.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
npx hardhat run scripts/upgrade/runMigration.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
SET_SYMBOL_TYPES_GAS_LIMIT=5000000 CHUNK_SIZE=100 \
npx hardhat run scripts/upgrade/setSymbolType.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
WHITELIST_SIGNER_ROLE=upgradeOperator TX_GAS_LIMIT=1500000 \
npx hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network coti

# 10. Unpause immediately with upgradeOperator.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=unpause \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 11. Optional: enable cross mode before revoking MIGRATION_ROLE.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=migrationRunner UPGRADE_STAGES=cross-mode \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=migrationRunner UPGRADE_STAGES=cross-partyb \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 12. Revoke migrationRunner roles with upgradeOperator.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=migration-revoke \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=symbol-revoke \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 13. Revoke temporary non-admin operator roles with upgradeOperator.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=operator-revoke \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti

# 14. Revoke temporary DEFAULT_ADMIN_ROLE grants with protocolAdmin.
USE_KEYSTORE=true RPC_COTI=https://mainnet.coti.io/rpc \
HARDWARE_WALLET_RPC_URL=http://127.0.0.1:<port> \
UPGRADE_STAGES=operator-admin-revoke \
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti
```

## Prerequisites

- Deployment info for the target network (see [Address Mapping](#address-mapping) below)
- Subgraph endpoint synced to current chain state (for migration)
- Hardhat keystore with the keys needed for the selected flow and optional RPC override (`RPC_<NETWORK>`):

    ```bash
    npx hardhat keystore set NEW_DEPLOYER           # protocolAdmin / diamond owner key (override name via KEYSTORE_DEPLOYER_KEY)
    npx hardhat keystore set TEAM_UPGRADE_OPERATOR  # temporary upgradeOperator key
    npx hardhat keystore set TEAM_MIGRATOR          # migrationRunner key (MIGRATION_ROLE)
    npx hardhat keystore set TEAM_PROPOSER          # Safe proposer / delegate key
    npx hardhat keystore set RPC_ARBITRUM           # optional RPC override (per network)
    ```

    `NEW_DEPLOYER` falls back to the legacy `TEAM_DEPLOYER` name if that is what your keystore already holds.

    Scripts auto-select the correct signer by matching the address from `upgrade.json` (`protocolAdmin` / `upgradeOperator` / `migrationRunner`) against available signers. For hardware-wallet `protocolAdmin` flows, use `HARDWARE_WALLET_RPC_URL` or direct Ledger scanning instead of storing the owner key in the keystore.

    **Important:** keystore values are only read when `USE_KEYSTORE=true` is set. Without it, `hardhat.config.ts` falls back to public RPCs (e.g. `arbitrum.llamarpc.com`) and the `DUMMY_PRIVATE_KEY`. Prefix every hardhat command that needs the real keys / RPCs:

    ```bash
    USE_KEYSTORE=true npx hardhat run scripts/upgrade/<script>.ts --network <network>
    ```

    Or export it once per shell: `export USE_KEYSTORE=true`. Alternatively, pass the RPC inline for one-offs: `RPC_ARBITRUM=https://... npx hardhat run ...`.

- Config files (replace `<network>` with your target network, e.g. `arbitrum`):
    ```bash
    cp scripts/upgrade/config/samples/upgrade.sample.json scripts/upgrade/config/upgrade-<network>.json
    cp scripts/upgrade/config/samples/prepareMigration.sample.json scripts/upgrade/config/prepareMigration-<network>.json
    cp scripts/upgrade/config/samples/migrate.sample.json scripts/upgrade/config/migrate-<network>.json
    cp scripts/upgrade/config/samples/postMigration.sample.json scripts/upgrade/config/postMigration-<network>.json
    cp scripts/upgrade/config/samples/instantLayerTemplates.sample.json scripts/upgrade/config/instantLayerTemplates.json
    cp scripts/upgrade/config/samples/deployPeripherals.sample.json scripts/upgrade/config/deployPeripherals-<network>.json
    # edit upgrade-<network>.json with all shared fields (diamondAddress, subgraphEndpoint, safeAddress, etc.)
    # other config files only need script-specific fields -- they fall back to upgrade-<network>.json for shared values
    ```
    Build `partyBList-<network>.json` from the subgraph instead of maintaining it manually:
    ```bash
    SOLVER_CHAINS=<network> npx ts-node scripts/upgrade/fetchSolverList.ts
    ```
    Config files use network-postfixed names (e.g. `upgrade-arbitrum.json`, `partyBList-arbitrum.json`). Scripts resolve config files by trying `{name}-{network}.json` first, falling back to `{name}.json`. Env var overrides (e.g. `UPGRADE_CONFIG_FILE`) take top priority.

## Address Mapping

Every Symmio deployment has a standard set of contracts and roles. The table below maps these to the config fields used by the upgrade scripts.

| Deployment name                                                       | Example                       | Config field                                                  | Where it goes                                                          |
| --------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Symmio** (diamond proxy)                                            | `0x2Ecc...38B5`               | `diamondAddress`                                              | `upgrade.json` (other scripts fall back to this)                       |
| **Main MultiSig** (Gnosis Safe that owns the diamond)                 | `0x0C83...AFC4`               | `safeAddress`                                                 | `upgrade.json` (other scripts fall back to this)                       |
| **Protocol admin** (permanent owner / permanent default admin)        | `0x0C83...AFC4`               | `protocolAdmin`                                               | `upgrade.json`, `deployPeripherals.json`                               |
| **Upgrade operator** (temporary scoped executor)                      | any EOA or multisig           | `upgradeOperator`                                             | `upgrade.json`                                                         |
| **Fees MultiSig** (receives protocol fees)                            | `0x273a...3f12`               | `symmioFeeReceiver`                                           | `upgrade.json` (other scripts fall back to this)                       |
| **SignatureVerifier** (Muon signature verification contract)          | `0x94eE...FC2`                | `newV085Parameters.signatureVerifierAddress`                  | `upgrade.json`                                                         |
| **PartyB list** (for Diamond + IL registration + symbol whitelisting) | --                            | `partyBs` + `registerOnSymmioCore` + `registerOnInstantLayer` | `fetchSolverList.ts` -> `config/partyBList-{network}.json`             |
| **TimeLock** (12H or 3D, if diamond owner is a timelock)              | `0xA75F...c63`                | `timelockAddress`                                             | `upgrade.json` (used by `generateTimelockBatch.ts` to wrap diamondCut) |
| **Migration runner** (address that will call migration functions)     | any EOA or multisig           | `migrationRunner`                                             | `upgrade.json` (usually `upgradeOperator`)                             |
| **PartyB addresses** (all active PartyBs to enable cross mode)        | `[0x...]`                     | `partyBs`                                                     | `postMigration.json`                                                   |
| **Subgraph endpoint** (Goldsky/TheGraph for this chain)               | `https://api.goldsky.com/...` | `subgraphEndpoint`                                            | `upgrade.json` (other scripts fall back to this)                       |

**Notes:**

- `protocolAdmin` is the address that should remain privileged after cleanup. In the EOA path this is usually the hardware wallet owner.
- `upgradeOperator` is intentionally temporary. Grant it only scoped roles needed for the maintenance window, keep `UNPAUSER_ROLE` until the system is unpaused, then revoke it during final cleanup.
- If the diamond is owned by a **TimeLock** that is itself owned by the Main MultiSig, set `safeAddress` to the Main MultiSig and `timelockAddress` to the TimeLock.
- `migrationRunner` is the address granted `MIGRATION_ROLE` to execute `migrateQuotes()` and `migrateCrossLockedValues()`.
- Contracts like Collateral, Pauser, RebalancerToMsig, CallProxy Liquidator, and Fees Manager are **not** part of the upgrade config -- they are unchanged by the v0.8.5 upgrade. A new `SymmioSymbolManager` is deployed and wired during the upgrade (see `deployPeripherals.ts`).

## Testing

Before running the upgrade in production, test the full flow on localhost:

1. Deploy v0.8.4 from the previous codebase to a local Hardhat node
2. Run `eoaUpgrade.ts --network docker` against it
3. Run verification scripts

```bash
npx hardhat run scripts/upgrade/eoaUpgrade.ts --network docker
npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network docker
npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network docker
npx hardhat run scripts/upgrade/testTemplateExecution.ts --network docker
```

### Fork rehearsal

Test against real on-chain state before production:

```bash
# 1. Run upgrade on fork
npx hardhat run scripts/upgrade/forkUpgrade.ts --network fork-arbitrum

# 2. Verify (all auto-load from upgrade.json + output files)
npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network fork-arbitrum
npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network fork-arbitrum
FORK=true npx hardhat run scripts/upgrade/testTemplateExecution.ts --network fork-arbitrum

# 3. Run migration
npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network fork-arbitrum
npx hardhat run scripts/upgrade/runMigration.ts --network fork-arbitrum
```

### Verification scripts

| Script                        | What it checks                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyCoreBytecode.ts`       | Bytecode verification of deployed core facets against local compiled artifacts (library linking aware). Uses `NETWORK` env var to resolve `output/deployed-facets-{network}.json`                                                   |
| `verifyPeripheralBytecode.ts` | Bytecode verification of deployed peripherals (AccountLayer, InstantLayer, SymmioPartyB impl, SymmioSymbolManager, MuonSignatureVerifier) against local compiled artifacts. Handles library linking and immutable variable masking. |
| `verifyBatchCalldata.ts`      | All generated Safe batches + `diamondcut-calldata-{network}.json` byte-match what the current repo + config would produce. Run **before signing** in the Safe UI. See [Step 2c](#step-2c-verify-generated-calldata-recommended)     |
| `verifyBlockExplorer.ts`      | Block explorer source + ABI publication/verification for all deployed contracts. Reads deploy output files and handles library linking automatically. Run **after** correctness verifications.                                      |
| `verifyDiamondSelectors.ts`   | All v0.8.5 facet selectors registered on diamond                                                                                                                                                                                    |
| `verifyPeripheralWiring.ts`   | AccountLayer + InstantLayer roles, hooks, whitelist, templates                                                                                                                                                                      |
| `testTemplateExecution.ts`    | Full end-to-end: affiliate registration, sub-account, PartyB UUPS upgrade, EIP-712 delegation, sendQuote -> lockQuote -> openPosition via InstantLayer template                                                                     |

`testTemplateExecution.ts` auto-loads `diamondAddress` from `upgrade.json`, and `accountLayerDiamondAddress` + `instantLayerAddress` from the output files. No manual config needed.

**What is NOT covered by these scripts** (verified elsewhere):

- Migration correctness -- `forkUpgrade.ts` step 11 verifies pre/post upgrade snapshots; `runMigration.ts` verifies all migrated data
- v0.8.5 parameter values -- check on-chain after batch execution
- Cross-PartyB mode -- enabled post-migration via `UPGRADE_STAGES=cross-mode,cross-partyb`

## EOA: Single Script Upgrade

For EOA-owned diamonds, `eoaUpgrade.ts` runs the full upgrade in one command: deploys facets, pauses the system, applies the diamond cut, sets v0.8.5 parameters, deploys AccountLayer + InstantLayer + SymmioSymbolManager, wires integrations, and grants the migration role.

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

# Override diamond address
DIAMOND_ADDRESS=0x... USE_KEYSTORE=true npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum
```

What it does (in order):

| Step | Action                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 1    | Deploy v0.8.5 libraries + facets (resume-safe via `deployed-facets-{network}.json`)                          |
| 2    | Build diamond cut (diff current vs new selectors)                                                            |
| 3    | `setAdmin` + grant `PAUSER_ROLE`/`UNPAUSER_ROLE` + `pauseGlobal()`                                           |
| 4    | Apply diamond cut (single transaction)                                                                       |
| 5    | Set new v0.8.5 parameters from config (`newV085Parameters`)                                                  |
| 6    | Deploy AccountLayer Diamond + InstantLayer, wire integrations, setup templates                               |
| 7    | Deploy SymmioPartyB implementation + register PartyBs on InstantLayer                                        |
| 8    | Deploy SymmioSymbolManager, grant `SYMBOL_MANAGER_ROLE` + `FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE` on core Diamond |
| 9    | Grant `MIGRATION_ROLE` to configured `migrationRunner`                                                       |

After completion, the system is paused and ready for migration. Continue with [Step 3: Prepare Migration Input](#step-3-prepare-migration-input).

Output:

- `scripts/upgrade/output/deployed-facets-{network}.json` -- deployed facet addresses
- `scripts/upgrade/output/deployed-accountlayer-instantlayer.json` -- AccountLayer + InstantLayer addresses
- `scripts/upgrade/output/deployed-symbolmanager.json` -- SymmioSymbolManager address

---

## Step-by-Step Scripts

The steps below can be used individually (e.g. for Safe path, or if you need more control over the EOA upgrade process).

## Read Muon Config from v0.8.4 Diamond

**Run before anything else** to capture the TSS public key and gateway signer from the live v0.8.4 diamond:

```bash
USE_KEYSTORE=true DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/readMuonConfig.ts --network <network>
```

Reads `getMuonIds()` (public key, gateway, appId) and `getMuonConfig()` (validity times). The `muonAppId`, `upnlValidTime`, and `priceValidTime` persist in diamond storage across the upgrade -- they are output for reference only. The public key and gateway are what must be seeded onto the new external verifier.

Add the output to `upgrade.json` -> `newV085Parameters`:

```json
"muonPublicKeys": [{ "x": "123...", "parity": 1 }],
"muonGatewaySigners": ["0x..."],
"muonFunctionPermissions": ["Trading", "AccountManagement", "Settlement", "ForceClose", "Funding", "LiquidationPartyA", "LiquidationPartyB"]
```

Output: `scripts/upgrade/output/muon-config.json`

## Deploy SignatureVerifier

**Required when upgrading from v0.8.4.** In v0.8.4, Muon signature verification was inline in the diamond via `LibMuon`. In v0.8.5, it is refactored into an external `MuonSignatureVerifier` contract (`contracts/helpers/verification/SymmioSignatureVerifier.sol`) that must be deployed separately.

`deployPeripherals.ts` handles this automatically — it deploys `MuonSignatureVerifier(protocolAdmin)` and writes the address back to `upgrade.json` → `newV085Parameters.signatureVerifierAddress`. No separate step is needed.

TSS public keys, gateway signers, and per-function permissions are seeded automatically by the upgrade scripts (from `muonPublicKeys`, `muonGatewaySigners`, and `muonFunctionPermissions` in config). The Safe must have `SETTER_ROLE` on the verifier.

If upgrading a chain that already runs v0.8.5 (or where the verifier was deployed previously), skip this step and use the existing verifier address.

## Step 1: Deploy Facets

Deploys all v0.8.5 libraries and facets. Supports resume -- if `deployed-facets-{network}.json` already exists, previously deployed contracts are skipped. Logs RPC connection info (chain ID, block number) before starting.

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/deployFacets.ts --network arbitrum
```

Output: `scripts/upgrade/output/deployed-facets-arbitrum.json` (network name is appended automatically)

## Step 2: Apply Upgrade

### EOA path

Reads `deployed-facets-{network}.json`, diffs selectors against the live diamond, and executes a single `diamondCut` transaction from the connected signer (via Hardhat keystore).

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum

# Override diamond address
DIAMOND_ADDRESS=0x... USE_KEYSTORE=true npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum

# Custom facets file (overrides network-based resolution)
FACETS_FILE=./path/to/deployed-facets-arbitrum.json USE_KEYSTORE=true npx hardhat run scripts/upgrade/applyUpgrade.ts --network arbitrum
```

Output:

- `scripts/upgrade/output/upgrade-details.json` -- selector changes (add/replace/remove)

The script applies all facet cuts in a **single transaction** (no chunking needed for EOA).

### Safe path

Generates Safe Transaction Builder JSON for the full upgrade (roles, pause, params, migration role, AccountLayer/InstantLayer/SymbolManager wiring) plus separate diamondCut calldata.

**Prerequisites:** Run `deployFacets.ts`, `deployPeripherals.ts`, and `fetchSolverList.ts` first. The script auto-loads `deployed-facets-{network}.json` and `deployed-peripherals-{network}.json` from the output directory -- no manual address copy needed. If `muonPublicKeys` or `muonGatewaySigners` are configured, `muonFunctionPermissions` must also be configured so the post-diamondCut batch includes `setPublicKeyPermissions` and `setGatewaySignerPermissions`. PartyB registration reads from `config/partyBList-{network}.json`: entries are registered on core Diamond when `registerOnSymmioCore` is true (default) and on InstantLayer when `registerOnInstantLayer` is true (default). `fetchSolverList.ts` writes both flags as true for every generated chain file; `generateSafeBatch.ts` then pre-filters both lists against live on-chain registration state, so already-registered solvers are skipped and batches are safe to regenerate and re-run. Config and env vars override auto-loaded values if set.

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/generateSafeBatch.ts --network arbitrum
```

After writing `safe-batch-{network}.json`, `generateSafeBatch.ts` immediately runs the `muon-verifier-safe-batch` check against the generated file. If configured Muon public keys or gateway signers are missing registration or permission transactions, generation exits non-zero before the artifact is handed to operators.

Output:

- `scripts/upgrade/output/pause-safe-batch.json` -- Safe batch for pause (grantRole PAUSER/UNPAUSER + pauseGlobal)
- `scripts/upgrade/output/safe-batch.json` -- Safe batch for post-diamondCut (roles, params, wiring, accept AL ownership)
- `scripts/upgrade/output/diamondcut-calldata.json` -- raw diamondCut calldata chunks
- `scripts/upgrade/output/upgrade-details.json` -- selector changes + breakdown

**Direct (Safe owns diamond):**

1. Import `pause-safe-batch.json` → execute (pause system)
2. Execute the diamondCut calldata from `diamondcut-calldata.json` as a separate Safe tx
3. Import `safe-batch.json` → execute (roles + params + wiring + accept AL ownership)

**TimeLock (TimeLock owns diamond):**

1. Run `generateTimelockBatch.ts` first (see [Step 2b](#step-2b-wrap-diamondcut-for-timelock))
2. Import `timelock-schedule-safe-batch.json` → execute (schedules diamondCut, timer starts)
3. Wait for timelock delay (system still live)
4. Import `pause-safe-batch.json` → execute (pause)
5. Import `timelock-execute-safe-batch.json` → execute (applies diamondCut)
6. Import `safe-batch.json` → execute (roles + params + wiring + accept AL ownership)

## Step 2b: Wrap DiamondCut for TimeLock

**Only needed when the diamond is owned by a TimeLock contract.** Reads `diamondcut-calldata.json` (output of `generateSafeBatch.ts`), fetches `minDelay` from the timelock, and wraps the diamondCut as timelock `schedule()` + `execute()` calls.

Requires `timelockAddress` in `upgrade.json` (or `TIMELOCK_ADDRESS` env var).

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/generateTimelockBatch.ts --network arbitrum
```

Output:

- `scripts/upgrade/output/timelock-schedule-safe-batch.json` -- Safe batch to schedule the diamondCut (execute immediately at T=0)
- `scripts/upgrade/output/timelock-execute-safe-batch.json` -- Safe batch to execute after timelock delay

Uses a deterministic salt derived from chain ID + diamond address + version string.

## Step 2c: Verify Generated Calldata (recommended)

Before signing any batch in the Safe UI, confirm every generated JSON matches what the current repo + config would produce. The verifier decodes each transaction and byte-compares against the expected calldata reconstructed from `upgrade-{network}.json`, `partyBList-{network}.json`, `instantLayerTemplates.json`, `deployed-facets-{network}.json`, and `deployed-peripherals-{network}.json`.

```bash
npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network arbitrum
```

What it checks, per file:

| File                                                                                           | Checks                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pause-safe-batch-{network}.json`                                                              | Exactly the 3 expected txs (grant PAUSER, grant UNPAUSER, pauseGlobal) on the diamond                                                                                                                                                                   |
| `safe-batch-{network}.json`                                                                    | Every non-diamondCut tx byte-matches the current generator output (roles, v0.8.5 params, Muon verifier key/gateway registration and permission seeding, AL/IL wiring, SymbolManager wiring, PartyB registration, templates)                             |
| `muon-verifier-safe-batch`                                                                     | Explicitly checks `safe-batch-{network}.json` has `addPublicKey`, `addGatewaySigner`, `setPublicKeyPermissions`, and `setGatewaySignerPermissions` for every configured Muon key/gateway signer                                                         |
| `diamondcut-calldata-{network}.json`                                                           | Decodes each chunk; asserts facetAddress ∈ deployed-facets, selectors belong to their facet, `_init == 0x0`, `_calldata == 0x`, no duplicate selectors across chunks. Optionally cross-checks `deployed-facets.json` selectors against the compiled ABI |
| `timelock-{schedule,execute}-safe-batch-{network}-N.json`                                      | Each file targets `timelockAddress`; inner calldata equals `diamondcut-calldata.chunks[N]`; predecessor chain is consistent and starts at `0x0`; salts match `keccak256(abi.encode(chainId, diamond, "diamondCut-v0.8.5", N))`                          |
| `post-migration-{safe-batch,transactions}-{network}.json`                                      | `revokeRole` × 2, `unpauseGlobal`, `setCrossPartyBModeActivated(true)`, `setCrossPartyB(partyB, true)` × N (reading PartyBs from `postMigration.json`)                                                                                                  |
| `grant-symbol-role-safe-batch-{network}.json` / `revoke-symbol-role-safe-batch-{network}.json` | Single `grantRole` / `revokeRole` for `SYMBOL_MANAGER_ROLE` targeting `migrationRunner`                                                                                                                                                                 |
| `add-templates-safe-batch-{network}.json`                                                      | One `addTemplate` tx per entry in `config/instantLayerTemplates.json`, targeting `instantLayerAddress`                                                                                                                                                  |

Every Safe batch also asserts `meta.createdFromSafeAddress == upgrade.json.safeAddress`.

**Configuration** (`config/verifyBatch.json`, optional — see `config/samples/verifyBatch.sample.json`):

| Field                                  | Description                                                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `networkName`                          | Override the network suffix used to resolve files (default: from `--network`)                                                                                                                                              |
| `networkNames`                         | Verify multiple generated network artifact sets in one run. Env `NETWORKS=a,b,c` overrides both `networkName` and `networkNames`                                                                                           |
| `outputDir`                            | Directory containing the generated JSON files (default: `./scripts/upgrade/output`)                                                                                                                                        |
| `configDir`                            | Directory containing `upgrade-{network}.json` / `partyBList-{network}.json` / `instantLayerTemplates.json`                                                                                                                 |
| `only`                                 | Array of labels to verify; omit to verify all. Env `ONLY=a,b,c` overrides                                                                                                                                                  |
| `skip`                                 | Array of labels to skip (applied after `only`). Env `SKIP=a,b` overrides                                                                                                                                                   |
| `verifyFacetSelectorsAgainstArtifacts` | When true (default), the selectors recorded in `deployed-facets-{network}.json` are cross-checked against the locally compiled facet ABIs — catches a tampered deployed-facets file. Env `VERIFY_ARTIFACTS=false` disables |
| `paths`                                | Per-file overrides for every input the verifier reads (batch files, deploy outputs, configs). Useful for verifying artifacts from another branch or a different output directory                                           |

Available labels (for `only` / `skip` / env `ONLY` / `SKIP`):

```
pause-safe-batch, safe-batch, muon-verifier-safe-batch,
diamondcut-calldata,
timelock-schedule-safe-batch, timelock-execute-safe-batch,
post-migration-safe-batch, post-migration-transactions,
grant-symbol-role-safe-batch, revoke-symbol-role-safe-batch,
add-templates-safe-batch
```

To sweep only the Muon verifier key/gateway registration and permission calls across every generated network artifact set:

```bash
NETWORKS=arbitrum,base,bsc \
ONLY=muon-verifier-safe-batch \
VERIFY_ARTIFACTS=false \
npx hardhat run scripts/upgrade/verifyBatchCalldata.ts --network default
```

The script exits non-zero if any check fails and prints per-file issue lists (expected vs actual selector, `to`, or calldata) to make diagnosis straightforward.

## Step 3: Prepare Migration + Symbol Inputs

Fetches subgraph data and builds the migration input file. In the EOA/operator path used for COTI, run this after `pauseGlobal()` so the migration and symbol inputs are based on paused state. This uses only version-agnostic on-chain calls (`getNextQuoteId`, which returns the last assigned ID), so it can still run before the diamondCut. Hardhat upgrade scripts that run the shared RPC check print the resolved `Network` and `RPC URL` before the chain/block check.

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/prepareMigrationInput.ts --network arbitrum
USE_KEYSTORE=true npx hardhat run scripts/upgrade/validateMigrationInput.ts --network arbitrum
USE_KEYSTORE=true npx hardhat run scripts/upgrade/validateMigrationEdgeCases.ts --network arbitrum
USE_KEYSTORE=true npx hardhat run scripts/upgrade/fetchSymbolList.ts --network arbitrum

# Dry run: fetch and print symbols without writing the symbol input file.
DRY_RUN=true USE_KEYSTORE=true npx hardhat run scripts/upgrade/fetchSymbolList.ts --network arbitrum
```

What it does:

- Fetches quotes from the subgraph by `quoteId` and filters open/migratable statuses locally
- Fetches all PartyB-per-PartyA balance entries from the subgraph
- Validates boundary against on-chain `getNextQuoteId()` (returns last assigned ID, not next available)
- Computes expected aggregated positions for post-migration verification
- Writes the symbol-types input consumed later by `setSymbolType.ts`
- Writes JSON input file

Outputs:

- `scripts/upgrade/output/migration-input-{network}.json`
- `scripts/upgrade/output/{count}-symbol-types-input-{network}.json`

## Step 3b: Validate Migration Input (optional)

Two complementary scripts validate the input. Both use raw `eth_call` and work on v0.8.4 and v0.8.5.

**`validateMigrationInput.ts`** -- random spot-checks quotes and balances for broad coverage:

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/validateMigrationInput.ts --network arbitrum
```

**`validateMigrationEdgeCases.ts`** -- deterministic checks for corner cases (boundary quote at `lastId`, fork drift, gap scan, partyB completeness). Especially important on fork tests:

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/validateMigrationEdgeCases.ts --network arbitrum
```

## Step 4: Run Migration + Symbol Updates

Execute migration using the validated paused-state input file. Then use the paused-state symbol input to backfill `symbolType` and whitelist that symbol type for PartyBs. The executor must have `MIGRATION_ROLE`; `runMigration.ts` checks this role for the resolved `migrationRunner` before executing. In dry-run mode, a missing role is reported as a warning and the dry run continues. `setSymbolType.ts` similarly checks `SYMBOL_MANAGER_ROLE`, and `whitelistSymbolTypes.ts` checks `PARTY_B_MANAGER_ROLE`; both include the result in their dry-run summaries. Symbol updates use the configured `migrationRunner` signer and require `SYMBOL_MANAGER_ROLE` / `PARTY_B_MANAGER_ROLE`.

```bash
USE_KEYSTORE=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network arbitrum

USE_KEYSTORE=true SET_SYMBOL_TYPES_GAS_LIMIT=5000000 npx hardhat run scripts/upgrade/setSymbolType.ts --network arbitrum
USE_KEYSTORE=true WHITELIST_SIGNER_ROLE=upgradeOperator npx hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network arbitrum
```

What it does:

- **Phase 1: Quote migration** -- calls `migrateQuotes()` in chunks (populates aggregated positions, connections, funding baselines)
- **Phase 2: PartyB balance migration** -- calls `migrateCrossLockedValues()` in chunks per PartyB (aggregates per-PartyA balances into cross bucket)
- **Verification** -- checks every quote is migrated, master balances match, aggregated positions correct

Output: `scripts/upgrade/output/migration-report.json`

### Resume after failure

If the script fails (RPC error, gas issue), re-run the same command. It reads `migration-progress.json` and resumes from the last successful operation.

### Dry run

```bash
USE_KEYSTORE=true DRY_RUN=true DIAMOND_ADDRESS=0x... MIGRATION_INPUT_FILE=./scripts/upgrade/output/migration-input.json \
  npx hardhat run scripts/upgrade/runMigration.ts --network arbitrum

USE_KEYSTORE=true DRY_RUN=true npx hardhat run scripts/upgrade/setSymbolType.ts --network arbitrum
USE_KEYSTORE=true DRY_RUN=true WHITELIST_SIGNER_ROLE=upgradeOperator npx hardhat run scripts/upgrade/whitelistSymbolTypes.ts --network arbitrum
```

`fetchSymbolList.ts` dry run does not write the symbol input file. `setSymbolType.ts` and `whitelistSymbolTypes.ts` dry runs do not submit transactions; both still write dry-run reports with their role preflight results.

## Step 5: Post-Migration

After `migration-report.json` shows `"status": "success"` and symbol whitelisting is complete, unpause first with `upgradeOperator`. Cross-mode setup is optional; if used, it must happen before `MIGRATION_ROLE` is revoked.

```bash
USE_KEYSTORE=true UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=unpause \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

# Optional cross-mode setup.
USE_KEYSTORE=true UPGRADE_SIGNER_ROLE=migrationRunner UPGRADE_STAGES=cross-mode \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

USE_KEYSTORE=true UPGRADE_SIGNER_ROLE=migrationRunner UPGRADE_STAGES=cross-partyb \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

USE_KEYSTORE=true UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=migration-revoke \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

USE_KEYSTORE=true UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=symbol-revoke \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

USE_KEYSTORE=true UPGRADE_SIGNER_ROLE=upgradeOperator UPGRADE_STAGES=operator-revoke \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum

USE_KEYSTORE=true UPGRADE_STAGES=operator-admin-revoke \
  npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum
```

PartyB addresses are read from `postMigration.json` config (`partyBs` array), or from `POST_MIGRATION_PARTYBS` / `CROSS_PARTYBS` / `PARTYBS`.

The stages, in order:

| #   | Transaction                         | Purpose                                   |
| --- | ----------------------------------- | ----------------------------------------- |
| 1   | `unpauseGlobal()`                   | Resume system operations                  |
| 2   | `setCrossPartyBModeActivated(true)` | Optional: enable cross-PartyB feature     |
| 3   | `setCrossPartyB(partyB, true)`      | Optional: enable cross mode per PartyB    |
| 4   | `revokeRole(MIGRATION_ROLE)`        | Remove temporary migration permission     |
| 5   | `revokeRole(SYMBOL_MANAGER_ROLE)`   | Remove temporary symbol permission        |
| 6   | `operator-revoke`                   | Remove temporary non-admin operator roles |
| 7   | `operator-admin-revoke`             | Remove temporary operator default admin   |

## Production Verification

There are three distinct verification gates:

| Gate                        | Scripts                                                  | Purpose                                                              |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Bytecode parity             | `verifyCoreBytecode.ts`, `verifyPeripheralBytecode.ts`   | Compare deployed online bytecode against local repo artifacts        |
| Block explorer source + ABI | `verifyBlockExplorer.ts`                                 | Publish/verify source and ABI metadata for the already deployed code |
| Final wiring/state          | `verifyDiamondSelectors.ts`, `verifyPeripheralWiring.ts` | Confirm diamond selectors, roles, hooks, whitelists, and templates   |

### Bytecode verification (local vs on-chain)

Compares the on-chain deployed bytecode against locally compiled Hardhat artifacts. This is independent of block explorer verification and works for any RPC-accessible network.

```bash
# Core facets: reads deployed-facets-{network}.json
NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyCoreBytecode.ts

# Peripherals: reads deployed-peripherals-{network}.json
NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts
```

Common live-network examples:

```bash
# BSC
NETWORK=bsc RPC_URL=https://bsc-rpc.publicnode.com npx ts-node scripts/upgrade/verifyCoreBytecode.ts
NETWORK=bsc RPC_URL=https://bsc-rpc.publicnode.com npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts

# Arbitrum
NETWORK=arbitrum RPC_URL=https://arb1.arbitrum.io/rpc npx ts-node scripts/upgrade/verifyCoreBytecode.ts
NETWORK=arbitrum RPC_URL=https://arb1.arbitrum.io/rpc npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts

# COTI
NETWORK=coti RPC_URL=https://mainnet.coti.io/rpc npx ts-node scripts/upgrade/verifyCoreBytecode.ts
NETWORK=coti RPC_URL=https://mainnet.coti.io/rpc npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts
```

These scripts run standalone via `ts-node` (not `npx hardhat run`), so they use the `NETWORK` env var to resolve the correct output file (e.g. `NETWORK=arbitrum` -> `deployed-facets-arbitrum.json`). Both also read from `scripts/upgrade/output/`. `verifyPeripheralBytecode.ts` also picks up the `MuonSignatureVerifier` address from `upgrade-{network}.json` (`newV085Parameters.signatureVerifierAddress`). For legacy operator commands, the old `NETWORK=<network> RPC_URL=<rpc> npx ts-node scripts/upgrade/verifyPeripherals.ts` alias still delegates to `verifyPeripheralBytecode.ts`; prefer the explicit `verifyPeripheralBytecode.ts` command in new runbooks.

Override env vars (takes precedence over `NETWORK`-based resolution):

```bash
FACETS_FILE=./output/deployed-facets-arbitrum.json RPC_URL=https://arb1.arbitrum.io/rpc npx ts-node scripts/upgrade/verifyCoreBytecode.ts
PERIPHERALS_FILE=./output/deployed-peripherals-arbitrum.json RPC_URL=https://arb1.arbitrum.io/rpc npx ts-node scripts/upgrade/verifyPeripheralBytecode.ts
```

**When to run:** after `deployFacets.ts` / `deployPeripherals.ts` and before applying the diamondCut, to confirm the standalone pre-deployed bytecodes match the local compiled source.

**What they handle:**

- **Library linking** -- facets that use external libraries (e.g. `LibQuoteFunding`, `LibSettlement`) have placeholder slots in compiled bytecode. The scripts extract actual library addresses from on-chain bytecode and substitute them before comparing.
- **Immutable variables** -- contracts like `InstantLayer` and `SymmioPartyB` embed constructor-set values (EIP-712 domain, symmio address, etc.) in deployed bytecode. The scripts mask these regions using `immutableReferences` from the artifact before comparing, and report the on-chain values.

**Prerequisites:** Run `npx hardhat compile` first. Artifacts must be present in `artifacts/contracts/`.

### Block explorer source + ABI verification

After correctness verifications (bytecode + calldata), publish/verify source and ABI on the block explorer:

```bash
USE_KEYSTORE=true npx hardhat run scripts/upgrade/verifyBlockExplorer.ts --network <network>
```

Publishes/verifies all libraries, core facets, AccountLayer contracts (DiamondCutFacet, Diamond, Init, libraries, facets), InstantLayer, SymmioSymbolManager, and SymmioPartyB implementation. Library dependencies and contract path disambiguation are handled automatically. Addresses are read dynamically from `scripts/upgrade/output/deployed-facets-{network}.json` and `deployed-peripherals-{network}.json` (resolved from `--network`), constructor args from `config/upgrade-{network}.json`. Resume with `SKIP=N` if a contract fails.

The script defaults to Hardhat Verify's Etherscan provider. COTI automatically uses the Blockscout provider because COTI Scan is Blockscout-based. Override with `VERIFY_PROVIDER=etherscan`, `VERIFY_PROVIDER=blockscout`, or `VERIFY_PROVIDER=sourcify` when needed.

### Final wiring/state verification

After the diamondCut + wiring batch:

```bash
# Verify all v0.8.5 facet selectors are registered
RPC_<NETWORK>=<rpc> npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network <network>

# Verify AccountLayer + InstantLayer wiring (roles, hooks, templates)
RPC_<NETWORK>=<rpc> npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network <network>
```

Common live-network examples:

```bash
# BSC
RPC_BSC=https://bsc-rpc.publicnode.com npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network bsc
RPC_BSC=https://bsc-rpc.publicnode.com npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network bsc

# Arbitrum
RPC_ARBITRUM=https://arb1.arbitrum.io/rpc npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network arbitrum
RPC_ARBITRUM=https://arb1.arbitrum.io/rpc npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network arbitrum

# COTI
RPC_COTI=https://mainnet.coti.io/rpc npx hardhat run scripts/upgrade/verifyDiamondSelectors.ts --network coti
RPC_COTI=https://mainnet.coti.io/rpc npx hardhat run scripts/upgrade/verifyPeripheralWiring.ts --network coti
```

Also review `upgrade-details.json` for the full selector diff (added, replaced, removed).

After migration:

```bash
jq '{status, error}' scripts/upgrade/output/migration-report.json
```

The migration report includes:

- `quoteChecks` -- number of quotes verified as migrated
- `partyBChecks` -- number of PartyBs with verified master balances
- `aggregateChecks` -- number of aggregated position entries verified

## Configuration

### Upgrade config (`upgrade-{network}.json`)

| Field                        | Type     | Default | What to put here                                                                                                                                                                          |
| ---------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diamondAddress`             | string   | --      | **Symmio** diamond proxy address (the main protocol contract)                                                                                                                             |
| `protocolAdmin`              | string   | `""`    | Permanent protocol admin / current v0.8.4 owner. For EOA-owned chains this can be the hardware wallet owner and should be the only address that keeps `DEFAULT_ADMIN_ROLE` after cleanup. |
| `upgradeOperator`            | string   | `""`    | Optional temporary executor for scoped operational work. Grant only the required roles for the maintenance window and revoke them after unpause during final cleanup.                     |
| `safeAddress`                | string   | `""`    | **Main MultiSig** -- the Gnosis Safe used in Safe Transaction Builder (Safe path only)                                                                                                    |
| `migrationRunner`            | string   | `""`    | Address that will run `migrateQuotes` / `migrateCrossLockedValues`. Usually the `upgradeOperator`, but can be separate.                                                                   |
| `timelockAddress`            | string   | `""`    | **TimeLock** contract address -- set if diamond is owned by a timelock (used by `generateTimelockBatch.ts`)                                                                               |
| `diamondCutChunkSize`        | number   | `1000`  | Max facet selector changes per `diamondCut` transaction (increase only if hitting gas limits)                                                                                             |
| `subgraphEndpoint`           | string   | `""`    | Goldsky / TheGraph subgraph URL for this chain (used by `prepareMigrationInput.ts`)                                                                                                       |
| `subgraphEndpoints`          | string[] | `[]`    | Optional ordered fallback list of subgraph endpoints. Used by `prepareMigrationInput.ts` when set.                                                                                        |
| `spotCheckCount`             | number   | `20`    | Number of random quotes/balances to verify against on-chain state during migration prep                                                                                                   |
| `symmioFeeReceiver`          | string   | `""`    | **Fees MultiSig** -- receives protocol fees in AccountLayer. `deployPeripherals.ts` requires this; `eoaUpgrade.ts` deploy stages fall back to `protocolAdmin` if empty.                   |
| `setupInstantLayerTemplates` | boolean  | `true`  | Whether to register OpenPosition + ClosePosition templates on InstantLayer                                                                                                                |
| `newV085Parameters`          | object   | --      | New v0.8.5 parameters (see [newV085Parameters](#newv085parameters) below)                                                                                                                 |

`accountLayerDiamondAddress`, `instantLayerAddress`, `symbolManagerAddress`, and `symmioPartyBImplementation` are auto-loaded from `deployed-peripherals-{network}.json` (resolved from the `--network` flag). They can still be set in config or env vars as overrides.

**Shared field fallback:** All per-script config files fall back to `upgrade-{network}.json` for shared fields (`diamondAddress`, `subgraphEndpoint`, `safeAddress`, `symmioFeeReceiver`, `spotCheckCount`). You only need to set these once in `upgrade-{network}.json` -- the other config files only need their script-specific fields. Per-script config values and env vars take precedence when set.

### Deploy peripherals config (`deployPeripherals-{network}.json`)

Note: `protocolAdmin` here is the admin for the **newly deployed** MuonSignatureVerifier, AccountLayer, InstantLayer, and SymmioSymbolManager contracts. For EOA-owned chains, use the same permanent owner/hardware-wallet address that should remain privileged after cleanup.

| Field               | Type   | What to put here                                                                                                                               |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocolAdmin`     | string | Permanent admin -- will be set as owner/admin for the new MuonSignatureVerifier, AccountLayer, InstantLayer, and SymmioSymbolManager contracts |
| `symmioFeeReceiver` | string | **Fees MultiSig** -- fee receiver for AccountLayer initialization. Falls back to `upgrade.json`.                                               |

### Prepare migration config (`prepareMigration-{network}.json`)

| Field               | Type     | What to put here                                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `subgraphEndpoints` | string[] | Optional ordered fallback list of subgraph endpoints. The script tries each endpoint before waiting/retrying. |
| `subgraphPageSize`  | number   | Optional subgraph page size. Lower this (for example `500` or `250`) if the gateway returns 504.              |
| `spotCheckCount`    | number   | Number of random entries to verify against on-chain (default 20). Falls back to `upgrade.json`.               |
| `outputDir`         | string   | Output directory (default `./scripts/upgrade/output`)                                                         |
| `outputFile`        | string   | Output file path (default `./scripts/upgrade/output/migration-input.json`)                                    |

### Migration config (`migrate-{network}.json`)

| Field                | Type    | What to put here                                         |
| -------------------- | ------- | -------------------------------------------------------- |
| `migrationInputFile` | string  | Path to `migration-input.json` (output of previous step) |
| `chunkSize`          | number  | Quotes per `migrateQuotes` transaction (default 50)      |
| `dryRun`             | boolean | `true` to simulate without sending transactions          |
| `fork`               | boolean | `true` if running on a fork network                      |

### Post-migration config (`postMigration-{network}.json`)

| Field     | Type     | What to put here                                                 |
| --------- | -------- | ---------------------------------------------------------------- |
| `partyBs` | string[] | List of all active **PartyB** addresses to enable cross mode for |

### Env var overrides

| Env var                                                                            | Overrides                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USE_KEYSTORE`                                                                     | Set to `true` to use Hardhat keystore keys and RPC overrides (required for all `npx hardhat run` commands on live networks)                                                                                                                                           |
| `RPC_<NETWORK>`                                                                    | One-off or keystore-backed RPC override for Hardhat scripts (for example `RPC_BASE`, `RPC_BSC`, `RPC_ARBITRUM`, `RPC_COTI`)                                                                                                                                           |
| `RPC_URL`                                                                          | RPC endpoint for standalone `ts-node` verification scripts (`verifyCoreBytecode.ts`, `verifyPeripheralBytecode.ts`)                                                                                                                                                   |
| `DRY_RUN`                                                                          | Preview supported migration/symbol scripts without writing or submitting where applicable (`runMigration.ts`, `fetchSymbolList.ts`, `setSymbolType.ts`, `whitelistSymbolTypes.ts`)                                                                                    |
| `SKIP_MIGRATION_ROLE_CHECK`                                                        | Skip the resolved signer `MIGRATION_ROLE` preflight in `runMigration.ts`                                                                                                                                                                                              |
| `SKIP_SYMBOL_MANAGER_ROLE_CHECK`                                                   | Skip the `SYMBOL_MANAGER_ROLE` preflight in `setSymbolType.ts`                                                                                                                                                                                                        |
| `SKIP_PARTY_B_MANAGER_ROLE_CHECK`                                                  | Skip the `PARTY_B_MANAGER_ROLE` preflight in `whitelistSymbolTypes.ts`                                                                                                                                                                                                |
| `TEAM_DEPLOYER` / `TEAM_UPGRADE_OPERATOR` / `TEAM_MIGRATOR`                        | Private-key slots loaded by `hardhat.config.ts`; keep `upgradeOperator` and `migrationRunner` in separate keystore entries                                                                                                                                            |
| `DIAMOND_ADDRESS`                                                                  | `diamondAddress`                                                                                                                                                                                                                                                      |
| `UPGRADE_STAGES` / `EOA_UPGRADE_STAGES`                                            | Comma-separated EOA stages (`deploy`, `facets`, `peripherals`, `operator-grant`, `pause`, `cut`, `params`, `wiring`, `partyb`, `migration`, `cross-mode`, `cross-partyb`, `migration-revoke`, `symbol-revoke`, `unpause`, `operator-revoke`, `operator-admin-revoke`) |
| `UPGRADE_SIGNER_ROLE` / `EOA_UPGRADE_SIGNER_ROLE`                                  | Signer role for non-owner stages. Use `upgradeOperator` after `operator-grant` for operator stages, role revokes, and unpause; use `migrationRunner` for cross-mode stages; use `protocolAdmin` for `cut`, `operator-grant`, and `operator-admin-revoke`.             |
| `UPGRADE_OPERATOR`                                                                 | Override `upgradeOperator` from config                                                                                                                                                                                                                                |
| `POST_MIGRATION_PARTYBS` / `CROSS_PARTYBS` / `PARTYBS`                             | Comma-separated PartyBs for `UPGRADE_STAGES=cross-partyb`; overrides `postMigration-{network}.json`                                                                                                                                                                   |
| `FACETS_FILE`                                                                      | Path to `deployed-facets-{network}.json` (overrides network-based resolution)                                                                                                                                                                                         |
| `PERIPHERALS_FILE`                                                                 | Path to `deployed-peripherals-{network}.json` (overrides network-based resolution)                                                                                                                                                                                    |
| `SYMBOL_MANAGER_ADDRESS`                                                           | Override SymmioSymbolManager address for Safe batch wiring                                                                                                                                                                                                            |
| `NETWORK`                                                                          | Network name for `ts-node` scripts (e.g. `arbitrum`) -- resolves output file names. Not needed for `npx hardhat run` scripts (uses `--network` flag automatically)                                                                                                    |
| `UPGRADE_CONFIG_FILE`                                                              | Config file path (default: `scripts/upgrade/config/upgrade-{network}.json`, falls back to `upgrade.json`)                                                                                                                                                             |
| `SUBGRAPH_ENDPOINTS`                                                               | Comma-separated ordered fallback list of subgraph endpoints. Each retry cycle tries all endpoints before sleeping.                                                                                                                                                    |
| `SUBGRAPH_PAGE_SIZE`                                                               | Page size for subgraph pagination in migration/symbol fetchers. Use a smaller value if the endpoint returns 504.                                                                                                                                                      |
| `SUBGRAPH_MIN_PAGE_SIZE`                                                           | Minimum page size for automatic retry page splitting. Defaults to `10`.                                                                                                                                                                                               |
| `SUBGRAPH_MAX_RETRIES`                                                             | Number of retries per subgraph request before reducing page size or failing. Defaults to `5`.                                                                                                                                                                         |
| `SUBGRAPH_RETRY_DELAY_MS`                                                          | Base retry delay in milliseconds. Delay increases linearly by attempt. Defaults to `2000`.                                                                                                                                                                            |
| `SUBGRAPH_TIMEOUT_MS`                                                              | Per-request subgraph timeout in milliseconds. Defaults to `60000`.                                                                                                                                                                                                    |
| `SUBGRAPH_RESUME`                                                                  | Set to `false` to ignore an existing `prepareMigrationInput.ts` open-quotes checkpoint and start a fresh subgraph scan. Defaults to resume enabled.                                                                                                                   |
| `SUBGRAPH_PROGRESS_FILE`                                                           | Override the `prepareMigrationInput.ts` open-quotes checkpoint path. Defaults to `output/prepareMigrationInput-openQuotes-progress-{network}.json`.                                                                                                                   |
| `HARDWARE_WALLET_RPC_URL` / `HW_WALLET_RPC_URL` / `EXTERNAL_WALLET_RPC_URL`        | External wallet RPC that exposes the hardware-wallet account for signer resolution                                                                                                                                                                                    |
| `PROTOCOL_ADMIN_RPC_URL` / `UPGRADE_OPERATOR_RPC_URL` / `MIGRATION_RUNNER_RPC_URL` | Role-specific external wallet RPCs; these take precedence for the matching role                                                                                                                                                                                       |
| `HW_WALLET=ledger` / `HARDWARE_WALLET=ledger`                                      | Enable direct Ledger signer support                                                                                                                                                                                                                                   |
| `LEDGER_CONFIG_FILE`                                                               | Override the shared non-secret Ledger path config. Defaults to `scripts/upgrade/config/ledger-{network}.json`, then `ledger.json`                                                                                                                                     |
| `LEDGER_PATH` / `HW_LEDGER_PATH`                                                   | Known Ledger derivation path                                                                                                                                                                                                                                          |
| `LEDGER_PATHS` / `HW_LEDGER_PATHS`                                                 | Comma-separated extra Ledger paths to scan first                                                                                                                                                                                                                      |
| `LEDGER_SCAN=true` / `HW_LEDGER_SCAN=true`                                         | Scan common Ledger paths when the path is unknown                                                                                                                                                                                                                     |
| `LEDGER_ACCOUNT_COUNT` / `LEDGER_ADDRESS_COUNT`                                    | Ledger scan ranges for account-based and legacy address-index paths                                                                                                                                                                                                   |
| `EXPECTED_ADDRESS` / `HARDWARE_ROLE`                                               | Hardware wallet discovery filters used by `listHardwareWalletAccounts.ts`                                                                                                                                                                                             |
| `EXPLICIT_GAS_LIMITS` / `USE_EXPLICIT_GAS_LIMITS`                                  | Force explicit gas limits. Defaults to enabled on `coti`.                                                                                                                                                                                                             |
| `DEPLOY_GAS_LIMIT`                                                                 | Gas limit for deployments; falls back to COTI default when explicit limits are enabled                                                                                                                                                                                |
| `TX_GAS_LIMIT` / `GAS_LIMIT`                                                       | Gas limit for normal write transactions                                                                                                                                                                                                                               |
| `MIGRATION_GAS_LIMIT` / `MIGRATE_GAS_LIMIT`                                        | Gas limit for `runMigration.ts` migration transactions; falls back to `TX_GAS_LIMIT` / `GAS_LIMIT`, then the COTI migration default.                                                                                                                                  |
| `SET_SYMBOL_TYPES_GAS_LIMIT` / `SYMBOL_TYPES_GAS_LIMIT`                            | Gas limit for `setSymbolType.ts` transactions; falls back to `TX_GAS_LIMIT` / `GAS_LIMIT`, then the COTI symbol-type default.                                                                                                                                         |
| `ACCOUNT_LAYER_CUT_GAS_LIMIT`                                                      | Gas limit for AccountLayer diamond cuts                                                                                                                                                                                                                               |
| `DIAMOND_CUT_GAS_LIMIT`                                                            | Gas limit for core diamond cuts                                                                                                                                                                                                                                       |

### Config files by script

All chain-specific config files support network-postfixed names (e.g. `upgrade-arbitrum.json`). Scripts try `{name}-{network}.json` first, fall back to `{name}.json`. Per-script configs only need script-specific fields -- they fall back to `upgrade-{network}.json` for shared fields.

| Config file                        | Script                                                                                 | Script-specific fields                                                                                               | Shared fields (from `upgrade-{network}.json`)          |
| ---------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `upgrade-{network}.json`           | `eoaUpgrade.ts`, `applyUpgrade.ts`, `generateSafeBatch.ts`, `generateTimelockBatch.ts` | `protocolAdmin`, `upgradeOperator`, `timelockAddress`, `newV085Parameters`, `diamondCutChunkSize`, `migrationRunner` | -- (source of truth)                                   |
| `deployPeripherals-{network}.json` | `deployPeripherals.ts`                                                                 | `protocolAdmin`                                                                                                      | `diamondAddress`, `symmioFeeReceiver`, `safeAddress`   |
| `prepareMigration-{network}.json`  | `prepareMigrationInput.ts`                                                             | `subgraphEndpoints`, `subgraphPageSize`, `subgraphProgressFile`, `outputDir`, `outputFile`                           | `diamondAddress`, `subgraphEndpoint`, `spotCheckCount` |
| `migrate-{network}.json`           | `runMigration.ts`                                                                      | `migrationInputFile`, `chunkSize`, `dryRun`, `fork`                                                                  | `diamondAddress`                                       |
| `postMigration-{network}.json`     | `eoaUpgrade.ts` post stages / `generatePostMigrationBatch.ts`                          | `partyBs`                                                                                                            | `diamondAddress`, `safeAddress`                        |
| `partyBList-{network}.json`        | `generateSafeBatch.ts`, `whitelistSymbolTypes.ts`                                      | `partyBs`, `registerOnSymmioCore`, `registerOnInstantLayer`                                                          | `diamondAddress`, `newV085Parameters.symbolType`       |
| `instantLayerTemplates.json`       | `generateTemplateBatch.ts`                                                             | `templates`                                                                                                          | `safeAddress`, `instantLayerAddress`                   |

## newV085Parameters

These parameters **only exist in v0.8.5** (not in v0.8.4 storage). After `diamondCut`, they default to 0 and must be initialized.

| Parameter                         | Type             | What to put here                                                                                                                 |
| --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `maxPartyAConnectionLimit`        | number           | **REQUIRED** -- max PartyBs a PartyA can connect to. Migration fails if 0. Typical value: `5`                                    |
| `signatureVerifierAddress`        | address          | **SignatureVerifier** contract address -- the Muon oracle signature verification contract from your deployment                   |
| `muonPublicKeys`                  | array            | TSS public keys to seed on the verifier. Each entry: `{ "x": "uint256", "parity": 0\|1 }`. Read from `readMuonConfig.ts`         |
| `muonGatewaySigners`              | string[]         | Gateway signer addresses to seed on the verifier. Read from the v0.8.4 diamond via `readMuonConfig.ts`                           |
| `muonFunctionPermissions`         | string[]         | Per-function verifier permissions to grant to configured TSS keys and gateway signers. Required when keys/signers are configured |
| `liquidationInsuranceVault`       | address          | Address that receives liquidation insurance -- typically the **Fees MultiSig**                                                   |
| `maxLiquidationProfitPerPosition` | string (wei)     | Max profit kept from liquidation per position. Example: `"100000000000000000000"` = 100 tokens                                   |
| `softLiquidationPenaltyCollector` | address          | Address that receives soft liquidation penalties -- typically the **Fees MultiSig**                                              |
| `minAffiliateFee`                 | string (wei)     | Minimum affiliate fee floor. Example: `"100000000000000000"` = 0.1 token                                                         |
| `unbindCooldown`                  | number (seconds) | Cooldown before a PartyA can unbind from a PartyB. Example: `86400` = 1 day                                                      |
| `maxWithdrawParts`                | number           | Max parts a withdrawal can be split into. Example: `5`                                                                           |
| `minWithdrawCooldown`             | number (seconds) | Min time between withdrawal parts. Example: `43200` = 12 hours                                                                   |

Existing v0.8.4 parameters (cooldowns, limits, fee shares, etc.) are preserved in storage and NOT overwritten.

To update `liquidationInsuranceVault` / `maxLiquidationProfitPerPosition` on a diamond that is already upgraded, use the standalone one-off script. It reads the same `upgrade-{network}.json` target values, writes a calldata report and Safe batch by default, and for multisig chains it also prepares a Safe Transaction Service proposal when `safeAddress` is configured. Direct on-chain broadcast only happens when `EXECUTE=true` is set:

```bash
npx hardhat run scripts/upgrade/updateLiquidationInsuranceVaultParams.ts --network <network>

EXECUTE=true USE_KEYSTORE=true npx hardhat run scripts/upgrade/updateLiquidationInsuranceVaultParams.ts --network <network>

SUBMIT_SAFE_PROPOSAL=1 USE_KEYSTORE=true npx hardhat run scripts/upgrade/updateLiquidationInsuranceVaultParams.ts --network <network>

SUBMIT_SAFE_PROPOSAL=1 SAFE_SENDER_ADDRESS=0x... SAFE_PROPOSER_WALLET=ledger \
  npx hardhat run scripts/upgrade/updateLiquidationInsuranceVaultParams.ts --network <network>
```

## Troubleshooting

**"maxPartyAConnectionLimit" error during migration**
Set `maxPartyAConnectionLimit` in `newV085Parameters` config. Defaults to 0 after upgrade, which blocks migration.

**Subgraph not synced**
Wait for the subgraph to index past the upgrade block before running `prepareMigrationInput.ts`.

**Transaction failures during migration**
The script retries 3x with exponential backoff. Check RPC health, gas balance, and `MIGRATION_ROLE` grant.

**Stuck migration**
Delete `migration-progress.json` and re-run. Already-migrated items are skipped via on-chain checks.
