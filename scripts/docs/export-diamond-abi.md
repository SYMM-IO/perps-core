# Export live Diamond and contract ABIs

`exportDiamondAbi.mjs` builds interaction ABIs for named contracts. It detects EIP-2535 Diamonds,
EIP-1967 implementation and beacon proxies, EIP-1167 minimal proxies, and standard contracts on-chain,
so the address config does not need a type field. It is read-only and does not need a signer.

The exporter:

1. Pins the current RPC block.
2. Reads `eth_getCode`, proxy storage, and proxy implementations at that same block.
3. Attempts `facets()` to distinguish Diamonds from standard contracts.
4. For a Diamond, resolves every live facet and keeps only installed function selectors.
5. For a standard contract or proxy implementation, resolves one ABI from matching runtime bytecode, a verified explorer, or
   an exact dispatcher-selector snapshot.
6. Writes a complete selector report for every target, including matched, unmatched, ambiguous, and
   local-only signatures.
7. Writes `abi.json` and `manifest.json` only when every installed selector resolves without ambiguity.

On-chain contract code is runtime bytecode. Function selectors are the first four bytes of
`keccak256(<canonical function signature>)`, so a selector match identifies the function name and input
types within the candidate ABI set. Bytecode alone cannot reveal return types, event definitions,
parameter names, or custom errors. The report therefore records the source and proof strength of every
matched function and warns when only selector-level proof was available.

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
scripts/output/diamond-abi/hyperevm/core/report.json
scripts/output/diamond-abi/hyperevm/account-layer/abi.json
scripts/output/diamond-abi/hyperevm/account-layer/manifest.json
scripts/output/diamond-abi/hyperevm/account-layer/report.json
scripts/output/diamond-abi/hyperevm/instant-layer/abi.json
scripts/output/diamond-abi/hyperevm/instant-layer/manifest.json
scripts/output/diamond-abi/hyperevm/instant-layer/report.json
```

Use `abi.json` with the Diamond address, not with individual facet addresses:

```js
import abi from "./scripts/output/diamond-abi/hyperevm/core/abi.json" with { type: "json" };
import { Contract, JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.hyperliquid.xyz/evm");
const symmio = new Contract("0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB", abi, provider);
```

For a proxy target, use `abi.json` with the configured proxy address. The report records the pinned
implementation or beacon chain under `proxy`, while ABI resolution uses the final implementation
runtime bytecode.

## Read the selector report

`report.json.selectorVerification` is the primary completeness proof:

- `matched` gives the live selector, canonical signature, facet address when applicable, ABI source,
  and proof level.
- `unmatched` lists selectors for which no candidate signature was found.
- `ambiguous` lists selector collisions with more than one candidate signature.
- `localOnly` lists functions present in the selected local source but absent from the live selector
  set.
- `invalidAbiEntries` preserves local ABI entries that could not be parsed.

`exact-bytecode` means the local compiled runtime matched the on-chain runtime after resolving linked
libraries and declared immutable regions. `selector-match` means the canonical signature hashes to the
live selector, but outputs and non-function ABI entries remain source-derived.

When every selector is matched and unambiguous, the command exits `0` and writes `abi.json`,
`manifest.json`, and `report.json`.

When resolution is incomplete, the exporter removes stale complete outputs, writes
`abi.partial.json` plus `report.json`, and exits `2` after processing every selected target:

```bash
jq '{status, unmatched: .selectorVerification.unmatched, ambiguous: .selectorVerification.ambiguous}' \
  scripts/output/diamond-abi/hyperevm/core/report.json
```

Use `--allow-partial` only when a partial ABI is an intentional diagnostic input. It keeps the partial
filenames and report warnings but permits a zero exit status:

```bash
npm run abi:diamond -- --chain hyperevm --target core --allow-partial
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
4. A local artifact whose function selectors match the live Diamond loupe or standard dispatcher.
5. Current or historical repository ABI snapshots whose function selectors match.
6. A per-selector combination of available explorer, artifact, and snapshot candidates for diagnostic
   partial output.

For a standard contract without a bytecode match or verified explorer page, the exporter extracts the
`PUSH4 <selector> EQ` dispatcher entries and compares them with compiled artifacts and repository ABI
snapshots. It filters out functions that are not deployed. Custom assembly, optimized dispatchers that
do not use that pattern, and fallback routers can produce incomplete extraction; such targets receive
an incomplete report rather than a guessed complete ABI.

Selector-only fallbacks have a strict limitation: selectors prove function names and input types,
not outputs or non-function ABI entries. Review `report.json.warnings` and each matched function's
`proof` fields before treating those details as fully verified.

For Diamonds, the exporter verifies that the merged ABI contains exactly one function for every
selector returned by the loupe. For standard contracts, every extracted dispatcher selector must be
covered without a signature collision. Missing or ambiguous selectors are written to `report.json`
before the command returns exit code `2`.

Rerun the export after every Diamond cut, proxy upgrade, beacon upgrade, or contract redeployment. The
ABI, manifest, and report are snapshots of the block recorded in the output, not permanent statements
about upgradeable contracts.
