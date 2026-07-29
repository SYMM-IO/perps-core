# Export live Diamond and contract ABIs

`exportDiamondAbi.mjs` builds interaction ABIs for named contracts. It detects on-chain whether each
target implements the EIP-2535 Diamond loupe, so the address config does not need a type field. It is
read-only and does not need a signer.

The exporter:

1. Pins the current RPC block.
2. Attempts `facets()` to distinguish Diamonds from standard contracts.
3. For a Diamond, resolves every live facet and keeps only installed function selectors.
4. For a standard contract, resolves one ABI from matching runtime bytecode, a verified explorer, or
   an exact dispatcher-selector snapshot.
5. Writes a separate ABI and provenance manifest for every target.

Bytecode alone cannot reveal function return types, event definitions, parameter names, or custom errors. The manifest therefore records where every facet ABI came from and warns when only selector-level proof was available.

## HyperEVM

The tracked config contains the addresses that cannot be discovered reliably from the chain or a
public metadata service:

```json
{
	"targets": {
		"core": "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
		"account-layer": "0x812e98F31A4EfFC09dD82e6e87ff7456151a0dFB",
		"instant-layer": "0xCeE28784EFE6EEaf6da977D3F1d0cf05E62717eB"
	}
}
```

The chain name comes from the config filename. Chain ID, public RPC, explorer URL, request defaults,
artifact directory, current ABI files, version-branch ABI snapshots, and output paths are resolved
automatically.

Compile first so unverified explorer contracts can be compared with local runtime artifacts, then
export every configured target:

```bash
npm run compile
npm run abi:diamond -- --chain hyperevm
```

Select one target by label when needed:

```bash
npm run abi:diamond -- --chain hyperevm --target core
npm run abi:diamond -- --chain hyperevm --target account-layer
npm run abi:diamond -- --chain hyperevm --target instant-layer
```

Each target receives a separate ignored output directory:

```text
scripts/output/diamond-abi/hyperevm/core/abi.json
scripts/output/diamond-abi/hyperevm/core/manifest.json
scripts/output/diamond-abi/hyperevm/account-layer/abi.json
scripts/output/diamond-abi/hyperevm/account-layer/manifest.json
scripts/output/diamond-abi/hyperevm/instant-layer/abi.json
scripts/output/diamond-abi/hyperevm/instant-layer/manifest.json
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
	"targets": {
		"core": "0x...",
		"account-layer": "0x...",
		"instant-layer": "0x..."
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

The output override is a root directory; each selected target still receives its own label
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
4. For Diamond facets, a local artifact whose function selectors match.
5. For Diamond facets, current or historical repository ABI snapshots whose function selectors
   match.

For a standard contract without a bytecode match or verified explorer page, the exporter extracts the
`PUSH4 <selector> EQ` dispatcher entries and requires one repository ABI snapshot to cover all of
them. It filters out snapshot functions that are not deployed.

Selector-only fallbacks have a strict limitation: selectors prove function names and input types,
not outputs or non-function ABI entries. Review `manifest.json.warnings` before treating such entries
as fully verified.

For Diamonds, the exporter fails if any live selector cannot be resolved and verifies that the merged
ABI contains exactly one function for every selector returned by the loupe. For standard contracts,
every extracted dispatcher selector must be covered by the chosen ABI snapshot.

Rerun the export after every Diamond cut or contract redeployment. The ABI and manifest are snapshots
of the block recorded in `manifest.json`, not permanent statements about upgradeable contracts.
