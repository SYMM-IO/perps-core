# Export a live Diamond ABI

`exportDiamondAbi.mjs` builds an interaction ABI for an EIP-2535 Diamond from its current on-chain facet map. It is read-only and does not need a signer.

The exporter:

1. Pins the current RPC block.
2. Calls `facets()` on the Diamond loupe.
3. Fetches the ABI for every live facet.
4. Keeps only function ABI entries whose selectors are installed on that facet.
5. Deduplicates events and errors.
6. Writes an ABI and a provenance manifest.

Bytecode alone cannot reveal function return types, event definitions, parameter names, or custom errors. The manifest therefore records where every facet ABI came from and warns when only selector-level proof was available.

## HyperEVM

The tracked config contains the addresses that cannot be discovered reliably from the chain or a
public metadata service:

```json
{
	"diamonds": {
		"core": "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
		"account-layer": "0x812e98F31A4EfFC09dD82e6e87ff7456151a0dFB"
	}
}
```

The chain name comes from the config filename. Chain ID, public RPC, explorer URL, request defaults,
artifact directory, current ABI files, version-branch ABI snapshots, and output paths are resolved
automatically.

Compile first so unverified explorer contracts can be compared with local runtime artifacts, then
export every configured Diamond:

```bash
npm run compile
npm run abi:diamond -- --chain hyperevm
```

Select one Diamond by label when needed:

```bash
npm run abi:diamond -- --chain hyperevm --diamond core
npm run abi:diamond -- --chain hyperevm --diamond account-layer
```

Each Diamond receives a separate ignored output directory:

```text
scripts/output/diamond-abi/hyperevm/core/abi.json
scripts/output/diamond-abi/hyperevm/core/manifest.json
scripts/output/diamond-abi/hyperevm/account-layer/abi.json
scripts/output/diamond-abi/hyperevm/account-layer/manifest.json
```

Use `abi.json` with the Diamond address, not with individual facet addresses:

```js
import abi from "./scripts/output/diamond-abi/hyperevm/core/abi.json" with { type: "json" };
import { Contract, JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.hyperliquid.xyz/evm");
const symmio = new Contract("0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB", abi, provider);
```

### HyperEVM big-block mode

ABI export does not require big-block mode. It sends no transaction, uses no signer, and only makes
RPC reads pinned to one block.

For deployments that exceed the fast-block gas limit, follow Hyperliquid's
[dual-block architecture](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture)
and reuse the existing tasks in [`tasks/deploy/hyperevm.ts`](../../tasks/deploy/hyperevm.ts):

```bash
npx hardhat hyperevm:enable-big-blocks --network hyperevm
# deploy the large contracts
npx hardhat hyperevm:disable-big-blocks --network hyperevm
```

Do not add big-block toggling to a chain ABI config. It is signer-specific transaction policy, not an
ABI-discovery setting.

## Add another chain

Keep one tracked config per chain:

```text
scripts/config/diamond-abi/<chain>.json
```

Only add labels and addresses:

```json
{
	"diamonds": {
		"core": "0x...",
		"account-layer": "0x..."
	}
}
```

Labels must use lowercase letters, digits, and hyphens. They become output directory names.

Then run:

```bash
npm run abi:diamond -- --chain <chain>
```

An explicit config path and output override are also supported:

```bash
node scripts/exportDiamondAbi.mjs \
  --config scripts/config/diamond-abi/<chain>.json \
  --output /tmp/diamond-abi-<chain>
```

The output override is a root directory; each selected Diamond still receives its own label
subdirectory.

Public metadata for the repository's supported networks lives in `PUBLIC_CHAIN_PROFILES` in
`scripts/utils/diamondAbi.mjs`, separate from the address configs. Add a public chain profile there
only when the network is not already supported. Private RPCs remain environment overrides following
the existing `RPC_<CHAIN>` convention. `ETHERSCAN_APIKEY` is optional.

## ABI source order and proof strength

Sources are tried automatically in this order:

1. A local compiled artifact when its linked runtime bytecode matches on-chain exactly.
2. Etherscan V2 API ABI for a verified contract.
3. ABI embedded in an Etherscan-family verified source page.
4. A local artifact whose function selectors match.
5. Current or historical repository ABI snapshots whose function selectors match.

The final selector-only fallback is useful for older, unverified facets, but it has a strict limitation: selectors prove function names and input types, not outputs or non-function ABI entries. Review `manifest.json.warnings` before treating such entries as fully verified.

The exporter fails if any live selector cannot be resolved. It also verifies that the merged ABI contains exactly one function for every selector returned by the loupe.

Rerun the export after every Diamond cut. The ABI and manifest are a snapshot of the block recorded in `manifest.json`, not a permanent statement about an upgradeable contract.
