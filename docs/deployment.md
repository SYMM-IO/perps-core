# Deploying SYMMIO

End-to-end runbook for deploying the protocol to a new chain, using the `symmio` CLI.

Everything here has been executed: on a local node, and on a fork of Arbitrum One with a
production-shaped configuration. Where something has *not* been verified, it says so.

- [Before you start](#before-you-start)
- [1. Configure](#1-configure)
- [2. Preflight](#2-preflight)
- [3. Rehearse on a fork](#3-rehearse-on-a-fork)
- [4. Deploy](#4-deploy)
- [5. Verify](#5-verify)
- [6. Manual steps](#6-manual-steps)
- [Resuming a failed deployment](#resuming-a-failed-deployment)
- [Slow or congested chains](#slow-or-congested-chains)
- [Mirroring an existing deployment](#mirroring-an-existing-deployment)
- [Reference](#reference)

---

## Before you start

Four things decide whether a deployment is safe. Get them right and the rest is mechanical.

| | Why it matters |
|---|---|
| **Deployer key** | `PRIVATE_KEY` is **not read by anything**. The deployer comes from `NEW_DEPLOYER`, `TEAM_DEPLOYER`, or the hardhat keystore. With none set, the config falls back to a dummy key committed to this repository. |
| **`ADMIN_PUBLIC_KEY`** | Receives every role and both diamonds' ownership. The deployer's privileges are revoked at the end, so anything you get wrong here needs the admin to fix. Use a multisig. |
| **`COLLATERAL_ADDRESS`** | Empty means the deploy creates a `FakeStablecoin` anyone can mint, and wires it in permanently. `setCollateral` is not cleanly re-runnable — getting this wrong means redeploying. |
| **`DEPLOY_MOCK_VERIFIER`** | `true` installs a verifier that accepts **every** signature. Every price, uPnL and liquidation attestation becomes forgeable. |

`deploy:system` refuses to run on a known mainnet if any of these is unsafe. That guard is a
backstop, not a substitute for checking.

Prerequisites: Node 22+, a funded deployer, an RPC endpoint you control, and an Etherscan V2
API key if you want contract verification.

---

## 1. Configure

Copy the example and fill it in:

```bash
cp .env.example .env
```

The variables that matter for a mainnet deploy:

```
NEW_DEPLOYER="0x..."                 # the key that signs. NOT "PRIVATE_KEY".
RPC_ARBITRUM="https://..."           # your own endpoint; public RPCs drop transactions
ETHERSCAN_APIKEY="..."               # single V2 multichain key

ADMIN_PUBLIC_KEY="0x..."             # your multisig — receives all roles and ownership
SYMMIO_FEE_RECEIVER="0x..."
COLLATERAL_ADDRESS="0xaf88d065e77c8cC2239327C5EDb3A432268e5831"   # Arbitrum native USDC

DEPLOY_MOCK_VERIFIER="false"
REGISTER_DUMMY_AFFILIATE="false"

MUON_APP_ID="..."
MUON_PUBLIC_KEY_X="0x..."
MUON_PUBLIC_KEY_PARITY="0"
MUON_GATEWAY_SIGNERS="0x...,0x..."
MUON_UPNL_VALID_TIME="60"
MUON_PRICE_VALID_TIME="60"
```

Prefer the encrypted keystore over a key in a file:

```bash
npx hardhat keystore set NEW_DEPLOYER
```

Then set `USE_KEYSTORE=true`. Note this also makes `RPC_<NETWORK>` and `ETHERSCAN_APIKEY`
come from the keystore.

### Protocol parameters and InstantLayer templates

Cooldowns, limits, liquidator share and the InstantLayer templates come from
`tasks/config/protocol-<chainId>.json`. Without that file, built-in defaults are used.

Template **order is significant** — ids are assigned in array order and hedgers address
templates by id. See [Mirroring an existing deployment](#mirroring-an-existing-deployment).

```bash
symmio config show --chain 42161
```

---

## 2. Preflight

```bash
symmio doctor --network arbitrum
```

Checks the deployer identity (including whether it is one of the publicly-known keys), RPC
reachability and chainId agreement, deployer balance, the collateral token's identity and
decimals, the mock-verifier and dummy-affiliate switches, Muon configuration, the protocol
config file, and whether a checkpoint exists that would make `deploy:system` resume rather
than start fresh.

Exits non-zero if anything is blocking, so it can gate CI.

---

## 3. Rehearse on a fork

**Do not skip this.** It costs nothing and it is the only step that exercises the real code
path against real chain state.

```bash
npx hardhat deploy:system --network fork-arbitrum --fresh true
```

`fork-arbitrum` is an in-process EVM that lazily fetches real Arbitrum state over RPC. Your
deploy sees the real USDC contract, real balances and real code; writes stay local and
disappear when the process exits. Deployer accounts are Hardhat's pre-funded test accounts,
so gas is free.

Pin the block for reproducibility and speed: `FORK_BLOCK_NUMBER=<block>`.

The fork reports chainId 42161, so the mainnet safety guard evaluates your real
configuration and prints anything that **would block a real deployment** — without stopping
the rehearsal. Expect exactly one violation, the deployer key; anything else is a genuine
problem in your configuration.

Fork runs are isolated from real ones: records go to `tasks/data/42161-fork/` and the
checkpoint to `checkpoint-42161-fork.json`, so a rehearsal can never pollute or be resumed
by a real deployment.

**A rehearsal does not cover:** block-explorer verification, and Arbitrum's real gas
pricing (the fork uses simulated gas, not L1 calldata posting costs).

---

## 4. Deploy

```bash
symmio deploy --network arbitrum
```

This runs preflight, prints a plan, asks you to type the network name to confirm, deploys,
then verifies and health-checks. To drive the underlying task directly:

```bash
npx hardhat deploy:system --network arbitrum --verify true
```

What gets deployed, in order: collateral (or existing), signature verifier, Diamond + 31
facets (in chunks), AccountLayer diamond, InstantLayer, SymmioPartyB, SymbolManager, then
system wiring, then ownership transfer, then **revocation of the deployer's privileges**.

Every transaction is awaited to a receipt and logged with its hash and gas. Progress is
checkpointed after each step.

---

## 5. Verify

```bash
npx hardhat verify:all --network arbitrum
```

Failures are written to `verify-failed.json`; retry only those:

```bash
npx hardhat verify:all --retry-failed --network arbitrum
```

Then check the deployment's health:

```bash
npx hardhat check:deployment --network arbitrum --from-report true --admin 0x<multisig>
```

Both exit non-zero on failure, so CI can gate on them. And the on-chain view:

```bash
symmio status --network arbitrum
```

---

## 6. Manual steps

Three things the deployer **cannot** do. The deployment is not finished until they are done.

### a. Accept ownership — from the admin

Ownership is two-step. The deployer calls `transferOwnership` on **both** diamonds; the
admin must call `acceptOwnership()` on each:

- the core Diamond
- the AccountLayer diamond

Until then, ownership has not moved — and `owner` is what authorises `diamondCut`.

### b. Grant SymbolManager operator roles — from the admin

`SymmioSymbolManager`'s constructor grants `DEFAULT_ADMIN_ROLE` to the admin only, so the
deployer cannot grant operator roles. The deploy prints the exact command:

```bash
npx hardhat symbolManager:grantOperatorRoles --symbol-manager-address 0x<sm> --operator 0x<op> --network arbitrum
```

### c. Add trading symbols

`deploy:system` deploys the machinery but seeds no symbols.

Confirm the end state:

```bash
symmio status --network arbitrum
```

You want `deployer holds no admin role`, and both diamonds owned by the admin.

---

## Resuming a failed deployment

Deployments are checkpointed per chain. Re-run the same command — completed steps are
skipped and it continues where it stopped:

```bash
npx hardhat deploy:system --network arbitrum
```

A step is only recorded as complete once its transaction has been **mined**, so a dropped
or reverted transaction is retried rather than skipped.

To start over, `--fresh true` archives the existing checkpoint into
`tasks/data/checkpoints/completed/` rather than discarding it.

If the diamond cut failed part-way, the resume compares the installed selector set against
the expected one and re-cuts only the missing facets, skipping `init()` because it already
ran.

---

## Slow or congested chains

Each setup transaction is awaited to a receipt, so total time scales with block time.
Arbitrum's sub-second blocks make this negligible; slower chains need tuning.

| Variable | Default | What it does |
|---|---|---|
| `DEPLOY_TX_TIMEOUT` | `300` | Seconds to wait for one transaction before failing. Prevents hanging forever on a dropped tx or a stalled RPC. |
| `DEPLOY_SLOW_TX_NOTICE` | `30` | Seconds before printing a "still waiting" line with the tx hash, so you can tell mining from hung. |
| `DEPLOY_CONFIRMATIONS` | `1` | Confirmations per transaction. Raise where reorgs are a real risk. |

A timeout is not data loss — the deployment is checkpointed, so re-running resumes from the
same step. Check the explorer first in case the transaction did land.

---

## Mirroring an existing deployment

To make a new chain match an existing one, read the live configuration into a config file:

```bash
SYMMIO=0x<diamond> INSTANT_LAYER=0x<instantLayer> TARGET_CHAIN_ID=42161 \
  npx hardhat run scripts/exportProtocolConfig.ts --network hyperevm
```

That writes `tasks/config/protocol-42161.json`. Then confirm it matches:

```bash
symmio config diff --network hyperevm --symmio 0x<diamond> --instant-layer 0x<il> --against 42161
```

**Eight parameters have no on-chain getter** — `settlementCooldown`, `liquidatorShare`,
`liquidationTimeout`, `forceCloseCooldowns`, `forceCancelCooldown`,
`forceCancelCloseCooldown`, `pendingQuotesValidLength`, `maxPartyAConnectionLimit`. They are
recoverable from their `Set*` events, which needs an RPC serving historical logs; many
public endpoints refuse. Anything not recovered stays at the built-in default and is listed
under `_provenance.UNVERIFIED_still_defaults` in the config file. Confirm those by hand.

`instantOpenMode` is also not exposed by `getTemplates` and must be set manually in the JSON.

---

## Reference

### Environment variables

Read by the deploy path. Anything not listed is not read.

| Variable | Default | Notes |
|---|---|---|
| `NEW_DEPLOYER` / `TEAM_DEPLOYER` | — | The deployer key. **`PRIVATE_KEY` is not read.** |
| `USE_KEYSTORE` | `false` | Take keys, RPCs and the explorer key from the hardhat keystore |
| `RPC_<NETWORK>` | public endpoint | e.g. `RPC_ARBITRUM` |
| `ETHERSCAN_APIKEY` | — | Etherscan V2 multichain key |
| `ADMIN_PUBLIC_KEY` | deployer | Receives all roles and ownership |
| `SYMMIO_FEE_RECEIVER` | admin | |
| `COLLATERAL_ADDRESS` | — | Empty deploys a `FakeStablecoin` |
| `DEPLOY_MOCK_VERIFIER` | `false` | `true` accepts every signature |
| `REGISTER_DUMMY_AFFILIATE` | `false` | Registers a real on-chain test affiliate |
| `DEPLOY_PARTYB` | `true` | |
| `SET_ADL_ENABLED` | `false` | |
| `PARTYB_SIGNER` | — | ERC-1271 signer for SymmioPartyB |
| `DEPLOY_SYMBOL_MANAGER` | `true` | |
| `SYMBOL_MANAGER_OPERATOR` | — | Granted adder/remover roles |
| `SETUP_INSTANT_LAYER_TEMPLATES` | `true` | |
| `MUON_SIGNATURE_VERIFIER_ADDRESS` | — | Reuse an existing verifier |
| `MUON_APP_ID`, `MUON_PUBLIC_KEY_X`, `MUON_PUBLIC_KEY_PARITY`, `MUON_GATEWAY_SIGNERS` | — | Muon configuration |
| `MUON_UPNL_VALID_TIME` / `MUON_PRICE_VALID_TIME` | `300` | Seconds |
| `CREATE2_FACTORY_ADDRESS`, `DIAMOND_VANITY_PREFIX` | — / `573310` | Vanity Diamond address |
| `DEPLOY_TX_TIMEOUT`, `DEPLOY_SLOW_TX_NOTICE`, `DEPLOY_CONFIRMATIONS` | `300` / `30` / `1` | See [slow chains](#slow-or-congested-chains) |
| `DEPLOY_LOG_LEVEL` | `verbose` | `silent` \| `minimal` \| `verbose` |
| `FORK_BLOCK_NUMBER` | latest | Pin the block for `fork-*` networks |

### Where things are written

| Path | What |
|---|---|
| `tasks/data/<chainId>/` | Deployment records and the report, per chain |
| `tasks/data/<chainId>-fork/` | Same, for simulated (`fork-*`) runs |
| `tasks/data/checkpoints/checkpoint-<chainId>.json` | In-progress checkpoint |
| `tasks/data/checkpoints/completed/` | Archived checkpoints |
| `tasks/config/protocol-<chainId>.json` | Protocol parameters and templates |

### Networks

`arbitrum`, `base`, `bsc`, `mantle`, `hyperevm`, `sonic`, `plasma`, `bera`, `polygon`,
`mode`, `blast`, `iota`, `sei`, `coti`, plus `localhost` (a persistent `npx hardhat node`),
`default` (in-process, ephemeral) and the `fork-*` variants.

### See also

- [cli/README.md](../cli/README.md) — CLI reference
- [SCRIPTS_AUDIT.md](../SCRIPTS_AUDIT.md) — the audit behind these safeguards, and what remains open
