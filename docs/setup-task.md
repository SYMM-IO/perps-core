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

## What Gets Deployed

The `deploy:system` task deploys and configures the following contracts:

1. **Collateral** - FakeStablecoin (or uses existing if `COLLATERAL_ADDRESS` is set)
2. **Diamond** - Main protocol contract with all facets
3. **AffiliateHub** - Affiliate management (upgradeable proxy)
4. **AccountHub** - Account management (upgradeable proxy)
5. **AccountHubLens** - Read-only lens for AccountHub
6. **InstantLayer** - Instant settlement layer
7. **SymmioPartyB** - PartyB contract (optional, if `DEPLOY_PARTYB=true`)
8. **AccountManager** - For dummy affiliate (optional, if `REGISTER_DUMMY_AFFILIATE=true`)

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

- AffiliateHub receives SIGNER_ADMIN_ROLE and AFFILIATE_MANAGER_ROLE on Diamond
- AccountHub receives SIGNER_ADMIN_ROLE and INTERNAL_TRANSFER_TO_BALANCE_ROLE on Diamond
- InstantLayer receives INSTANT_LAYER_ROLE on Diamond
- AffiliateHub receives DEPLOYER_ROLE on AccountHub
- InstantLayer receives INSTANT_LAYER_ROLE on AccountHub

### InstantLayer Setup

- Admin receives SETTER_ROLE on InstantLayer
- Diamond (Symmio) is whitelisted on InstantLayer (setTargetWhitelist)
- AccountLayerDiamond is whitelisted on InstantLayer (setTargetWhitelist)

### PartyB Setup (if deployed)

- SymmioPartyB is registered in Diamond
- InstantLayer receives TRUSTED_ROLE on SymmioPartyB
- Admin receives MANAGER_ROLE on SymmioPartyB (for setMulticastWhitelist)
- Admin receives SETTER_ROLE on SymmioPartyB (for setSigner)
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
| Pending Quotes Valid Length | 10          |
| Max PartyA Connection Limit | 5           |

## Output

After deployment, you will receive:

1. **Console output** - Summary of all deployed contracts and their addresses
2. **Deployment report** - JSON file saved to `data/deployed.json`

Example output:

```
================================================================================
DEPLOYMENT REPORT
================================================================================

DEPLOYMENT SUMMARY
--------------------------------------------------------------------------------
Total Contracts: 8
Successful: 8
Failed: 0

DEPLOYED ADDRESSES
--------------------------------------------------------------------------------
Collateral:       0x5FbDB2315678afecb367f032d93F642f64180aa3
Diamond:          0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
AffiliateHub:     0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
AccountHub:       0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
AccountHubLens:   0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
InstantLayer:     0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
SymmioPartyB:     0x0165878A594ca255338adfa4d48449f69242Eb8F
AccountManager:   0xa513E6E4b8f2a923D98304ec87F64353C4D5C853
```

## Task Options

```bash
npx hardhat deploy:system [options]

Options:
  --verify      Verify contracts on block explorer (default: false)
  --log-data    Write deployment addresses to data files (default: true)
```

## Troubleshooting

### Deployment fails on PartyB

Make sure the Diamond deployment completed successfully before PartyB can be deployed.

### Role granting fails

Ensure the deployer address matches the private key in `.env` and has admin privileges.
