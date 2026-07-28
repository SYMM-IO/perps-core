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

The tracked config for the core Diamond at `0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB` is:

```text
scripts/config/diamond-abi/hyperevm.json
```

Compile first so unverified explorer contracts can be compared with local runtime artifacts:

```bash
npm run compile
npm run abi:diamond -- --chain hyperevm
```

The default output is ignored by Git:

```text
scripts/output/diamond-abi/hyperevm/abi.json
scripts/output/diamond-abi/hyperevm/manifest.json
```

Use `abi.json` with the Diamond address, not with individual facet addresses:

```js
import abi from "./scripts/output/diamond-abi/hyperevm/abi.json" with { type: "json" };
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

Copy the HyperEVM config and change at least:

- `name`
- `chainId`
- `diamondAddress`
- `rpc.url` and `rpc.urlEnv`
- explorer URLs and API-key environment variable
- `outputDirectory`
- ABI snapshots appropriate for that deployment history

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

Do not put RPC credentials or API keys in tracked config. Put the environment-variable name in config and export its value at runtime.

## ABI source order and proof strength

Sources are tried in config order:

1. Etherscan V2 API ABI for a verified contract.
2. ABI embedded in an Etherscan-family verified source page.
3. A verified page on another chain only when `runtimeMatch` proves the code at the same address is byte-for-byte identical.
4. A local compiled artifact only when its linked runtime bytecode matches on-chain.
5. If explicitly enabled, a local artifact or ABI snapshot whose function selectors match.

The final selector-only fallback is useful for older, unverified facets, but it has a strict limitation: selectors prove function names and input types, not outputs or non-function ABI entries. Review `manifest.json.warnings` before treating such entries as fully verified.

The exporter fails if any live selector cannot be resolved. It also verifies that the merged ABI contains exactly one function for every selector returned by the loupe.

Rerun the export after every Diamond cut. The ABI and manifest are a snapshot of the block recorded in `manifest.json`, not a permanent statement about an upgradeable contract.
