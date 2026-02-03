# System Deployment Guide

This guide explains how to deploy the complete Symmio system using the `deploy:system` task.

## Prerequisites

1. Copy `.env.example` to `.env` and configure the required variables
2. Ensure you have sufficient funds in the deployer wallet

## Environment Configuration

Configure the following variables in your `.env` file:

```bash
# Required: Your deployer's private key
PRIVATE_KEY="0x..."

# Optional: Admin address for all contracts (defaults to deployer wallet)
ADMIN_PUBLIC_KEY=""

# Optional: Fee receiver address (defaults to admin)
SYMMIO_FEE_RECEIVER=""

# Optional: Existing collateral token address
# If not set, a FakeStablecoin will be deployed (useful for local testing)
COLLATERAL_ADDRESS=""

# Deploy SymmioPartyB contract (default: true, set to "false" to skip)
DEPLOY_PARTYB="true"

# Optional: Signer address for SymmioPartyB (ERC-1271 signature verification)
PARTYB_SIGNER=""

# Register a dummy affiliate for testing (default: true, set to "false" to skip)
REGISTER_DUMMY_AFFILIATE="true"

# Setup InstantLayer templates for OpenPosition and ClosePosition flows
# (default: true, set to "false" to skip)
SETUP_INSTANT_LAYER_TEMPLATES="true"

# Deployment log level: "silent" (default), "minimal", or "verbose"
DEPLOY_LOG_LEVEL="minimal"
```

## Deployment

### Local Anvil Deployment (Recommended for PartyB Testing)

1. Start a local Anvil node:

```bash
anvil #or "anvil --disable-code-size-limit" if you see the limit problem
```

2. Configure `.env` for local testing (minimal config):

```bash
# Just the private key - everything else uses sensible defaults
PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
```

3. Run the deployment:

```bash
npx hardhat deploy:system --network localhost
```

### Testnet/Mainnet Deployment

```bash
npx hardhat deploy:system --network <NETWORK_NAME>
```

## Checkpoint System (Resumable Deployments)

The deployment system supports **checkpointing** for resumable deployments. If a deployment is interrupted (network error, out of gas, etc.), you can resume from where it left off.

### How It Works

- Checkpoint files are saved to `tasks/data/checkpoints/checkpoint-<chainId>.json`
- Each contract deployment and setup step is checkpointed immediately after completion
- On resume, already-completed steps are skipped automatically
- Diamond cuts are verified on-chain to handle edge cases where tx succeeded but checkpoint wasn't saved

### Commands

```bash
# Resume from existing checkpoint (default behavior)
npx hardhat deploy:system --network <NETWORK_NAME>

# Force fresh deployment, ignoring any existing checkpoint
npx hardhat deploy:system --network <NETWORK_NAME> --fresh
```

### Checkpoint Status Display

When resuming, you'll see a status display showing:
- Network and chain ID
- When the deployment started and was last updated
- Which contracts are already deployed
- Setup progress (roles granted, parameters set, etc.)

## What Gets Deployed

The `deploy:system` task deploys and configures the following contracts:

1. **Collateral** - FakeStablecoin (or uses existing if `COLLATERAL_ADDRESS` is set)
2. **Diamond** - Main protocol contract with 29 facets and 3 libraries
3. **AccountLayerDiamond** - Unified account/affiliate management with 6 facets
4. **InstantLayer** - Instant settlement layer for batched operations
5. **SymmioPartyB** - PartyB contract (optional, if `DEPLOY_PARTYB=true`)
6. **AccountManager** - For dummy affiliate (optional, if `REGISTER_DUMMY_AFFILIATE=true`)

## Roles and Permissions Setup

The task automatically configures:

### Diamond Roles (granted to admin)

- SYMBOL_MANAGER_ROLE, PAUSER_ROLE, UNPAUSER_ROLE
- PARTY_B_MANAGER_ROLE, SUSPENDER_ROLE, DISPUTE_ROLE
- AFFILIATE_MANAGER_ROLE, MUON_SETTER_ROLE
- LIQUIDATOR_ROLE, PARTYB_LIQUIDATOR_ROLE
- DEALLOCATE_COOLDOWN_SETTER_ROLE, INSTANT_LAYER_ROLE
- PROTOCOL_CONFIG_ROLE, FEE_ADMIN_ROLE, COOLDOWN_ADMIN_ROLE
- PROVIDER_ADMIN_ROLE, INTEGRATION_ADMIN_ROLE, BRIDGE_MANAGER_ROLE
- SIGNER_ADMIN_ROLE, EMERGENCY_ADMIN_ROLE, UNSUSPENDER_ROLE
- MIGRATION_ROLE, SUSPENDED_FUNDS_WITHDRAWER_ROLE
- FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE

### Contract Integrations

- AccountLayerDiamond receives SIGNER_ADMIN_ROLE, AFFILIATE_MANAGER_ROLE, and INTERNAL_TRANSFER_TO_BALANCE_ROLE on Diamond
- InstantLayer receives INSTANT_LAYER_ROLE on Diamond
- InstantLayer receives INSTANT_LAYER_ROLE on AccountLayerDiamond
- Symmio Core (Diamond) is whitelisted on AccountLayerDiamond

### AccountLayerDiamond Setup

- Admin receives DEFAULT_ADMIN_ROLE, SETTER_ROLE, APPROVER_ROLE, PAUSER_ROLE, UNPAUSER_ROLE

### InstantLayer Setup

- Admin receives DEFAULT_ADMIN_ROLE and SETTER_ROLE on InstantLayer
- Diamond (Symmio) is whitelisted on InstantLayer (setTargetWhitelist)
- AccountLayerDiamond is whitelisted on InstantLayer (setTargetWhitelist)
- AccountHub is set on InstantLayer (setAccountHub)

### InstantLayer Templates (if `SETUP_INSTANT_LAYER_TEMPLATES=true`)

Two templates are registered on InstantLayer to facilitate common trading flows:

#### OpenPosition Template (6 operations)

| Op | Function                         | Target             | Dependencies                      |
| -- | -------------------------------- | ------------------ | --------------------------------- |
| 0  | `predictNextVirtualAccountAddress` | AccountLayerDiamond | None (returns virtualAccount)   |
| 1  | `addMargin`                      | AccountLayerDiamond | virtualAccount from op 0 (param 1) |
| 2  | `sendQuoteWithAffiliateAndData`  | Diamond            | None (returns quoteId)           |
| 3  | `allocateForPartyB`              | Diamond            | partyA from op 0 (param 2)       |
| 4  | `lockQuote`                      | Diamond            | quoteId from op 2 (param 1)      |
| 5  | `openPosition`                   | Diamond            | quoteId from op 2 (param 1)      |

#### ClosePosition Template (4 operations)

| Op | Function                         | Target             | Dependencies                      |
| -- | -------------------------------- | ------------------ | --------------------------------- |
| 0  | `predictNextVirtualAccountAddress` | AccountLayerDiamond | None (returns virtualAccount)   |
| 1  | `requestToClosePosition`         | Diamond            | None (quoteId provided by user)  |
| 2  | `fillCloseRequest`               | Diamond            | None (quoteId provided by user)  |
| 3  | `deallocateForPartyB`            | Diamond            | partyA from op 0 (param 2)       |

### PartyB Setup (if deployed)

- SymmioPartyB is registered in Diamond
- Admin receives DEFAULT_ADMIN_ROLE, MANAGER_ROLE, and SETTER_ROLE on SymmioPartyB
- InstantLayer receives TRUSTED_ROLE on SymmioPartyB
- InstantLayer is added to multicastWhitelist on SymmioPartyB
- Signer is set on SymmioPartyB (if PARTYB_SIGNER is configured)
- SymmioPartyB is registered on InstantLayer (registerPartyBs - also grants OPERATOR_ROLE)

## System Parameters

The following default parameters are configured (matching test environment):

| Parameter                   | Value       |
| --------------------------- | ----------- |
| Balance Limit Per User      | 10,000      |
| Deallocate Cooldown         | 120 seconds |
| Settlement Cooldown         | 300 seconds |
| Deallocate Debounce Time    | 120 seconds |
| Liquidator Share            | 10%         |
| Liquidation Timeout         | 100 seconds |
| Force Close Cooldowns       | 300s, 120s  |
| Force Cancel Cooldown       | 300 seconds |
| Force Cancel Close Cooldown | 300 seconds |
| Pending Quotes Valid Length | 10          |
| Max PartyA Connection Limit | 5           |

## Output

After deployment, you will receive:

1. **Console output** - Summary of all deployed contracts and their addresses
2. **Deployment report** - JSON file saved to `data/deployment-report.json`
3. **Verification files** - Separate JSON files for contract verification:
   - `data/stablecoin.json` - Collateral contract
   - `data/deployed.json` - Core Diamond contracts and facets
   - `data/accountlayer.json` - AccountLayerDiamond contracts and facets
   - `data/instantlayer.json` - InstantLayer contract
   - `data/partyb.json` - SymmioPartyB contracts (proxy, implementation, admin)

Example output:

```
================================================================================
DEPLOYMENT REPORT
================================================================================

DEPLOYMENT SUMMARY
--------------------------------------------------------------------------------
Total Contracts: 6
Successful: 6
Skipped (from checkpoint): 0
Failed: 0

DEPLOYED ADDRESSES
--------------------------------------------------------------------------------
Collateral:           0x5FbDB2315678afecb367f032d93F642f64180aa3
Diamond:              0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
AccountLayerDiamond:  0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
InstantLayer:         0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
SymmioPartyB:         0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
AccountManager:       0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
```

## Task Options

```bash
npx hardhat deploy:system [options]

Options:
  --verify      Verify contracts on block explorer (default: false)
  --log-data    Write deployment addresses to data files (default: true)
  --fresh       Ignore checkpoint and start fresh deployment (default: false)
```

## Contract Verification

After deployment, verify all contracts on the block explorer:

```bash
# Verify all contracts from deployment logs
npx hardhat verify:all --network <NETWORK_NAME>

# Skip first N contracts (for resuming)
npx hardhat verify:all --network <NETWORK_NAME> --skip 10
```

The `verify:all` task reads from all deployment log files and verifies each contract.

## Troubleshooting

### Deployment fails mid-way

The checkpoint system will save progress. Simply run the same command again to resume:

```bash
npx hardhat deploy:system --network <NETWORK_NAME>
```

### Checkpoint appears corrupted

Force a fresh deployment:

```bash
npx hardhat deploy:system --network <NETWORK_NAME> --fresh
```

Or manually delete the checkpoint file:

```bash
rm tasks/data/checkpoints/checkpoint-<chainId>.json
```

### Role granting fails

Ensure the deployer address matches the private key in `.env` and has admin privileges.

### Diamond cut verification mismatch

If a diamond cut transaction succeeded but the checkpoint wasn't saved, the system will detect this on-chain and update the checkpoint automatically.
