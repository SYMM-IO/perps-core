import { address, canonical, codeHash, digest, selectorMap } from "./model.js";
import { BrowserProvider, Contract, JsonRpcProvider, JsonRpcSigner, getAddress, keccak256, toUtf8Bytes, toBeHex } from "ethers";

export const LOUPE_ABI = ["function facets() view returns ((address facetAddress,bytes4[] functionSelectors)[])"];
const OWNER_SLOT = toBeHex(BigInt(keccak256(toUtf8Bytes("diamond.standard.diamond.storage"))) + 3n, 32);
/**
 * `staticNetwork` is for a provider that only reads and whose chain the caller has already checked:
 * without it every request is preceded by its own `eth_chainId`, which doubles the traffic of a scan.
 */
export function rpcProvider(url, { staticNetwork = false } = {}) {
	const parsed = new URL(url);
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("RPC endpoint must use HTTP or HTTPS");
	return new JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1, ...(staticNetwork ? { staticNetwork: true } : {}) });
}
export async function inspect(provider, target, blockTag = "latest") {
	target = address(target);
	const block = await provider.getBlock(blockTag);
	if (!block?.hash) throw new Error("Latest block is unavailable");
	const at = block.number;
	const chainId = Number((await provider.getNetwork()).chainId);
	const diamondCode = await provider.getCode(target, at);
	if (diamondCode === "0x") throw new Error("No contract exists at the target address");
	const raw = await new Contract(target, LOUPE_ABI, provider).facets({ blockTag: at });
	const facets = [];
	for (const facet of raw) {
		const code = await provider.getCode(facet.facetAddress, at);
		if (code === "0x") throw new Error(`Facet ${facet.facetAddress} has no bytecode`);
		facets.push({ address: getAddress(facet.facetAddress), selectors: [...facet.functionSelectors].sort(), code, codeHash: codeHash(code) });
	}
	facets.sort((a, b) => a.address.localeCompare(b.address));
	const owner = address(`0x${(await provider.getStorage(target, OWNER_SLOT, at)).slice(-40)}`);
	const ownerCode = await provider.getCode(owner, at);
	let authority = { kind: ownerCode === "0x" ? "eoa" : "unknown-contract", address: owner, codeHash: codeHash(ownerCode) };
	if (ownerCode !== "0x") {
		try {
			const safe = new Contract(
				owner,
				[
					"function getOwners() view returns(address[])",
					"function getThreshold() view returns(uint256)",
					"function nonce() view returns(uint256)",
					"function VERSION() view returns(string)",
				],
				provider,
			);
			const [owners, threshold, nonce, version] = await Promise.all([
				safe.getOwners({ blockTag: at }),
				safe.getThreshold({ blockTag: at }),
				safe.nonce({ blockTag: at }),
				safe.VERSION({ blockTag: at }),
			]);
			if (threshold < 1 || threshold > owners.length || new Set(owners).size !== owners.length) throw new Error("Invalid Safe authority");
			authority = { ...authority, kind: "safe", owners: [...owners], threshold: Number(threshold), nonce: nonce.toString(), version };
		} catch {
			/* Keep unrecognized contracts explicitly unclassified. */
		}
	}
	const map = selectorMap(facets);
	const fingerprint = digest({
		chainId,
		target,
		diamondCodeHash: codeHash(diamondCode),
		facets: facets.map(({ code, ...f }) => f),
		owner,
		authority,
	});
	return {
		chainId,
		target,
		blockNumber: at,
		blockHash: block.hash,
		diamondCodeHash: codeHash(diamondCode),
		facets,
		map,
		owner,
		authority,
		fingerprint,
	};
}
export async function assertSnapshot(provider, snapshot) {
	const fresh = await inspect(provider, snapshot.target);
	if (fresh.fingerprint !== snapshot.fingerprint)
		throw new Error("The target, facet bytecode, selector routing, or upgrade authority changed. Inspect and prepare a new plan.");
	return fresh;
}
export async function verifyMap(provider, snapshot, finalMap) {
	const fresh = await inspect(provider, snapshot.target);
	if (
		fresh.chainId !== snapshot.chainId ||
		fresh.diamondCodeHash !== snapshot.diamondCodeHash ||
		fresh.owner !== snapshot.owner ||
		canonical(fresh.map) !== canonical(finalMap)
	)
		throw new Error("Post-upgrade verification failed: chain, diamond, owner, or selector map differs from the plan");
	for (const facet of fresh.facets) {
		const before = snapshot.facets.find(old => old.address === facet.address);
		if (before && before.codeHash !== facet.codeHash) throw new Error(`Retained facet bytecode changed: ${facet.address}`);
	}
	return fresh;
}
export async function createFork(url, snapshot) {
	const { createHardhatRuntimeEnvironment } = await import("hardhat/hre");
	const hre = await createHardhatRuntimeEnvironment({
		networks: {
			workbench: { type: "edr-simulated", chainId: snapshot.chainId, hardfork: "cancun", forking: { url, blockNumber: snapshot.blockNumber } },
		},
	});
	const connection = await hre.network.create("workbench");
	// Query the fork's own Cancun execution context, including for local chains
	// without a configured historical hardfork schedule.
	await connection.provider.request({ method: "evm_mine", params: [] });
	const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
	const impersonate = async who => {
		await connection.provider.request({ method: "hardhat_impersonateAccount", params: [who] });
		await connection.provider.request({ method: "hardhat_setBalance", params: [who, "0x3635c9adc5dea00000"] });
		return new JsonRpcSigner(provider, who);
	};
	return {
		provider,
		impersonate,
		close: async () => {
			provider.destroy();
			await connection.close();
		},
	};
}
