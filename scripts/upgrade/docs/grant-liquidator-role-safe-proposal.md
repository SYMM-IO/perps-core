# Grant Liquidator Role Safe Proposal

This runbook generates a Safe transaction for:

```text
ControlFacet.grantRole(<liquidator>, LIQUIDATOR_ROLE)
```

For Base, the configured liquidator is `0x885277c30b25632fd966684581578211513866d4`, recovered from the Base role history as the account whose `LIQUIDATOR_ROLE` was granted in `0xdacc6557a56f75bd389949a1ef5d6d015b9ede168f80ce48ebfc342bbf03317e` and revoked in `0xc689787985d75a0f9180828a9f4b1d5fb295ea7b9918e387a5e04605f3b37353`.

## Files

- Script: `scripts/upgrade/generateGrantLiquidatorRoleSafeProposal.ts`
- Base config: `scripts/upgrade/config/grantLiquidatorRole-base.json`
- Batch output: `scripts/upgrade/output/grant-liquidator-role/base/safe-batch.json`
- Safe proposal output: `scripts/upgrade/output/grant-liquidator-role/base/safe-proposal.json`

## Generate Local Batch Only

```bash
PROPOSE_TO_SAFE_SERVICE=0 ./node_modules/.bin/hardhat run scripts/upgrade/generateGrantLiquidatorRoleSafeProposal.ts --network base
```

Import the generated `safe-batch.json` into the Safe Transaction Builder if you want a UI-only path.

## Safe-Service Dry Run

This reads the queued Safe nonce, checks direct execution from the Safe, calls Safe Transaction Service estimation, and writes `safe-proposal.json` without submitting.

```bash
SUBMIT_SAFE_PROPOSAL=false ./node_modules/.bin/hardhat run scripts/upgrade/generateGrantLiquidatorRoleSafeProposal.ts --network base
```

## Submit A Safe Proposal

The proposal sender must match `safeProposal.senderAddress` in the config or `SAFE_SENDER_ADDRESS` if overridden. The repo loads the proposer key from `TEAM_PROPOSER`.

Keystore:

```bash
./node_modules/.bin/hardhat keystore set TEAM_PROPOSER
SUBMIT_SAFE_PROPOSAL=true \
CONFIRM_CHAIN_ID=8453 \
CONFIRM_SAFE_ADDRESS=0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9 \
USE_KEYSTORE=true \
./node_modules/.bin/hardhat run scripts/upgrade/generateGrantLiquidatorRoleSafeProposal.ts --network base
```

`.env` alternative:

```bash
SUBMIT_SAFE_PROPOSAL=true \
CONFIRM_CHAIN_ID=8453 \
CONFIRM_SAFE_ADDRESS=0x5146C35725d9b8F11A84ebD4a3abe9845698Ada9 \
TEAM_PROPOSER=0x... \
./node_modules/.bin/hardhat run scripts/upgrade/generateGrantLiquidatorRoleSafeProposal.ts --network base
```

This submits the proposal to Safe Transaction Service. It does not execute the Safe transaction on-chain.
The checked-in `safeProposal.submit` field remains `false` and cannot authorize submission by itself.

## Useful Overrides

```bash
LIQUIDATOR_ADDRESS=0x...
GRANT_ROLE=LIQUIDATOR_ROLE
SAFE_SENDER_ADDRESS=0x...
SAFE_NONCE=123
SAFE_SERVICE_API_KEY=...
SAFE_PROPOSAL_SIGNATURE=0x...
SAFE_ORIGIN="Symmio: grant LIQUIDATOR_ROLE to Orbs liquidator on Base"
```
