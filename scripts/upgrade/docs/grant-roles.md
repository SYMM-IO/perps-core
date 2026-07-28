# Grant Symmio Core Roles

Use `grantRoles.ts` to grant one or more roles on a Symmio core diamond. The
script reads public operational values from JSON and uses Hardhat's configured
signer for authenticated execution.

It calls the Symmio core API:

```solidity
grantRole(address user, bytes32 role)
```

This argument order is different from OpenZeppelin AccessControl's
`grantRole(bytes32 role, address account)`.

## Configuration

By default, the script loads:

```text
scripts/upgrade/config/grantRoles-<network>.json
```

If that file does not exist, it falls back to
`scripts/upgrade/config/grantRoles.json`. Set `GRANT_ROLES_CONFIG_FILE` to use
another path.

Example:

```json
{
	"chainId": 999,
	"diamondAddress": "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
	"grants": [
		{
			"account": "0x00c2796b3AD3369D604E009D75204D7a15Cc584b",
			"roles": ["CLEARING_HOUSE_ROLE"]
		}
	]
}
```

Each role can be either:

- a role name such as `CLEARING_HOUSE_ROLE`, which the script hashes with
  `keccak256`; or
- an exact 32-byte role hash beginning with `0x`.

The config must not contain private keys, RPC credentials, or other secrets.

## Configure the Hardhat keystore

Store the RPC and the private key used by the role admin:

```bash
npx hardhat keystore set RPC_HYPEREVM
npx hardhat keystore set TEAM_DEPLOYER
```

`TEAM_DEPLOYER` is the default signer key name. To use a different keystore
entry, set `KEYSTORE_DEPLOYER_KEY` when running the script.

## Dry run

Dry-run mode is the default. With no keystore, it validates the config and
reads current role state using the configured public RPC:

```bash
USE_KEYSTORE=false \
npx hardhat run scripts/upgrade/grantRoles.ts --network hyperevm
```

Use the real signer for a complete authorization and static-call preflight:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
npx hardhat run scripts/upgrade/grantRoles.ts --network hyperevm
```

The preview reports the diamond owner, signer, role hashes, current role state,
signer authorization, and exact calldata. It skips roles that are already
granted.

## Execute

Only set `DRY_RUN=false` after the authenticated dry run succeeds:

```bash
USE_KEYSTORE=true \
KEYSTORE_DEPLOYER_KEY=TEAM_DEPLOYER \
DRY_RUN=false \
npx hardhat run scripts/upgrade/grantRoles.ts --network hyperevm
```

Live execution requires `USE_KEYSTORE=true`. Before sending anything, the
script verifies all pending calls with `staticCall`. After each transaction, it
waits for the receipt and verifies `hasRole(account, role) == true`.
