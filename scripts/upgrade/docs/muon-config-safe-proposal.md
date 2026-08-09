# Muon Config Safe Proposal

This runbook generates or proposes a Safe transaction for:

```text
ControlFacet.setMuonConfig(upnlValidTime, priceValidTime)
```

`upnlValidTime` and `priceValidTime` are the on-chain validity windows, in seconds, for Muon UPNL and price signatures.

## Files

- Script: `scripts/upgrade/generateMuonConfigSafeBatch.ts`
- Default config: `scripts/upgrade/config/muon/default.json`
- Chain config: `scripts/upgrade/config/muon/<network>.json`
- BSC config: `scripts/upgrade/config/muon/bsc.json`
- Output: `scripts/upgrade/output/muon/<network>/safe-batch.json`
- Safe proposal output: `scripts/upgrade/output/muon/<network>/safe-proposal.json`

## Configure The Chain File

Example BSC config:

```json
{
	"diamondAddress": "0x9A9F48888600FC9c05f11E03Eab575EBB2Fc2c8f",
	"safeAddress": "0xa85A4A81274a0db6ee873e3068fF76e8a3e27Ac2",
	"muonUpnlValidTime": 60,
	"muonPriceValidTime": 60,
	"safeProposal": {
		"enabled": true,
		"submit": false,
		"senderAddress": "0x8A82bCDB72FFA4181a81C13d434AaCB59E7f327F"
	}
}
```

Fields:

- `diamondAddress`: Symmio core Diamond that receives `setMuonConfig`.
- `safeAddress`: Safe that owns or controls the Diamond role path.
- `muonUpnlValidTime`: UPNL signature validity in seconds.
- `muonPriceValidTime`: price signature validity in seconds.
- `safeProposal.enabled`: enables Safe Transaction Service nonce lookup, simulation, and proposal JSON.
- `safeProposal.submit`: legacy informational field. Checked-in configs keep it `false`; only the explicit per-run submission interlocks below authorize a POST.
- `safeProposal.senderAddress`: Safe owner or delegate that signs the proposal hash.
- `safeProposal.safeNonce`: optional manual nonce. Prefer leaving it unset or `null`; the script reads queued Safe proposals first, then falls back to on-chain nonce.

The chain file is merged over `default.json`, so missing fields may be inherited from the default config.

## Configure The Proposer Key

Safe proposal creation does not execute the transaction on-chain, but Safe Transaction Service still requires a signature from a Safe owner or registered delegate.

The repo loads proposer keys from `TEAM_PROPOSER`.

Keystore:

```bash
./node_modules/.bin/hardhat keystore set TEAM_PROPOSER
```

Paste the private key for the configured `safeProposal.senderAddress`.

Then run commands with:

```bash
USE_KEYSTORE=true
```

`.env` alternative:

```bash
TEAM_PROPOSER=0x...
```

The address derived from `TEAM_PROPOSER` must match `safeProposal.senderAddress`, or `SAFE_SENDER_ADDRESS` if that env override is used.

## Local Batch Only

This creates the Safe Transaction Builder batch file only. It does not call Safe Transaction Service and does not need the proposer key.

```bash
PROPOSE_TO_SAFE_SERVICE=0 ./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network bsc
```

Output:

```text
scripts/upgrade/output/muon/bsc/safe-batch.json
```

Import that file manually in the Safe UI if you do not want script-based proposal submission.

## Override The Period Without Editing JSON

```bash
PROPOSE_TO_SAFE_SERVICE=0 \
MUON_UPNL_VALID_TIME=300 \
MUON_PRICE_VALID_TIME=300 \
./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network bsc
```

This writes a batch for `setMuonConfig(300, 300)`.

## Safe-Service Dry Run

Use this when you want the script to read the queued Safe nonce, run execution preflight, call Safe Transaction Service estimation, and write `safe-proposal.json`, but not submit the proposal.

Set the chain config temporarily:

```json
"safeProposal": {
	"enabled": true,
	"submit": false,
	"senderAddress": "0x8A82bCDB72FFA4181a81C13d434AaCB59E7f327F"
}
```

Then run:

```bash
USE_KEYSTORE=true ./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network bsc
```

Output:

```text
scripts/upgrade/output/muon/bsc/safe-batch.json
scripts/upgrade/output/muon/bsc/safe-proposal.json
```

## Submit A Safe Proposal

Keep Safe-service preview enabled in the config:

```json
	"safeProposal": {
		"enabled": true,
		"submit": false,
	"senderAddress": "0x8A82bCDB72FFA4181a81C13d434AaCB59E7f327F"
}
```

Run with keystore:

```bash
SUBMIT_SAFE_PROPOSAL=true \
CONFIRM_CHAIN_ID=56 \
CONFIRM_SAFE_ADDRESS=0xa85A4A81274a0db6ee873e3068fF76e8a3e27Ac2 \
USE_KEYSTORE=true \
./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network bsc
```

Or with `.env`:

```bash
SUBMIT_SAFE_PROPOSAL=true \
CONFIRM_CHAIN_ID=56 \
CONFIRM_SAFE_ADDRESS=0xa85A4A81274a0db6ee873e3068fF76e8a3e27Ac2 \
TEAM_PROPOSER=0x... \
./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network bsc
```

This submits the proposal to Safe Transaction Service. It does not execute the Safe transaction on-chain.

## Useful Overrides

```bash
DIAMOND_ADDRESS=0x...
SAFE_ADDRESS=0x...
SAFE_SENDER_ADDRESS=0x...
SAFE_NONCE=122
SAFE_SERVICE_API_KEY=...
SAFE_PROPOSAL_SIGNATURE=0x...
SAFE_ORIGIN="Symmio: setMuonConfig(300, 300) on bsc"
```

Notes:

- `PROPOSE_TO_SAFE_SERVICE=0` disables Safe service entirely and only writes `safe-batch.json`.
- If `PROPOSE_TO_SAFE_SERVICE` is unset, the script uses `safeProposal.enabled` from the merged config.
- A proposal POST occurs only when `SUBMIT_SAFE_PROPOSAL=true`, `CONFIRM_CHAIN_ID` matches the connected RPC, and `CONFIRM_SAFE_ADDRESS` exactly matches the resolved Safe.
- Checked-in `safeProposal.submit` values never authorize submission.
- `SAFE_NONCE` overrides automatic nonce selection. Use it only when you intentionally want a specific nonce.

## Expected Checks

The script should print:

```text
Safe on-chain nonce:       ...
Safe queued proposal nonces: ...
Selected Safe nonce:       ...
Execution preflight passed (setMuonConfig).
Safe simulation passed.
```

For a simple Muon-period update, the generated batch should contain one call:

```text
setMuonConfig(<upnlValidTime>, <priceValidTime>)
```

## Troubleshooting

`Account ... is not managed by the node`

The configured proposal sender is not loaded by Hardhat. Add the matching private key:

```bash
./node_modules/.bin/hardhat keystore set TEAM_PROPOSER
USE_KEYSTORE=true ./node_modules/.bin/hardhat run scripts/upgrade/generateMuonConfigSafeBatch.ts --network bsc
```

`Sender is not a Safe owner or registered delegate`

Use a `senderAddress` that is a Safe owner or delegate, or add the proposer as a Safe delegate first.

`Execution preflight failed (setMuonConfig)`

The Safe likely does not hold `MUON_SETTER_ROLE` on the Diamond. Grant the role through the proper admin path before executing the batch, or enable `grantMuonSetterRole` only if the Safe can call `grantRole`.

Safe simulation returns `safeTxGas: "0"`

That can still be normal for Safe service estimation. Trust the direct execution preflight more than the `safeTxGas` value.
