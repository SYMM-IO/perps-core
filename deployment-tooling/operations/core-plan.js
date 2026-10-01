import { OperationError, operationDigest, validateDocument } from "./inputs.js";
import { Contract, Fragment, Interface, getAddress, keccak256 } from "ethers";

const CUT = "0x1f931c1c";
const LOUPE = ["function getOwner() view returns(address)", "function facets() view returns ((address facetAddress,bytes4[] functionSelectors)[])"];
const fail = (code, message) => {
	throw new OperationError(code, message);
};
const sorted = values => [...new Set(values.map(v => v.toLowerCase()))].sort();

/** Read-only by construction: the contract runner is a provider, never a signer. */
export async function captureCoreSnapshot(provider, resolved, atBlock) {
	validateDocument("resolved", resolved);
	const { profile, inputDigest } = resolved;
	if (BigInt(profile.network.chainId) !== (await provider.getNetwork()).chainId)
		fail("network-mismatch", "RPC chain differs from the deployment profile");
	const block = await provider.getBlock(atBlock ?? "latest");
	if (!block?.hash) fail("missing-block", "Snapshot block is unavailable");
	const target = profile.components.core;
	const core = new Contract(target.address, LOUPE, provider),
		overrides = { blockTag: block.number };
	const owner = getAddress(await core.getOwner(overrides));
	if (owner !== getAddress(target.upgradeAuthority)) fail("authority-mismatch", "Core owner differs from the profile upgrade authority");
	const code = await provider.getCode(target.address, block.number);
	if (code === "0x") fail("missing-code", "Core has no runtime bytecode");
	const entries = await core.facets(overrides),
		facets = [];
	for (const entry of entries) {
		const address = getAddress(entry.facetAddress),
			runtime = await provider.getCode(address, block.number);
		if (runtime === "0x") fail("missing-code", "Installed facet has no runtime bytecode");
		facets.push({ address, codeHash: keccak256(runtime), selectors: [...entry.functionSelectors].sort() });
	}
	facets.sort((a, b) => a.address.localeCompare(b.address));
	if ((await provider.getBlock(block.number))?.hash !== block.hash) fail("snapshot-reorg", "Snapshot block hash changed while reading");
	return validateDocument("snapshot", {
		schemaVersion: 1,
		kind: "symmio.snapshot",
		inputDigest,
		chainId: profile.network.chainId,
		blockNumber: block.number,
		blockHash: block.hash,
		core: getAddress(target.address),
		owner,
		coreCodeHash: keccak256(code),
		facets,
	});
}

/** Produces a symbolic release diff only. It cannot authorize or encode an upgrade. */
export function buildCorePlan(bundle, snapshot) {
	validateDocument("snapshot", snapshot);
	const { profile, release, inputDigest } = bundle.resolved,
		spec = release.components.core,
		target = profile.components.core;
	if (
		snapshot.inputDigest !== inputDigest ||
		snapshot.chainId !== profile.network.chainId ||
		getAddress(snapshot.core) !== getAddress(target.address)
	)
		fail("snapshot-mismatch", "Snapshot does not match the operation target");
	if (getAddress(snapshot.owner) !== getAddress(target.upgradeAuthority))
		fail("authority-mismatch", "Snapshot owner differs from the upgrade authority");
	if (!spec.supportedBaselines.includes(target.baseline.id))
		fail("unsupported-baseline", "The release does not support the deployment profile's baseline");
	if (operationDigest(sorted(snapshot.facets.map(f => f.codeHash))) !== operationDigest(sorted(target.baseline.facetCodeHashes)))
		fail("unsupported-baseline", "Installed facet code hashes do not match the deployment profile's reviewed baseline");
	const current = new Map(),
		desired = new Map(),
		artifacts = [];
	for (const facet of snapshot.facets)
		for (const selector of facet.selectors) {
			if (current.has(selector)) fail("duplicate-selector", "Installed diamond repeats a selector");
			current.set(selector, facet.address);
		}
	if (!current.has(CUT)) fail("missing-cut", "Installed diamondCut selector is missing");
	for (const [index, artifact] of bundle.artifacts.entries()) {
		const name = `${artifact.sourceName}:${artifact.contractName}`;
		let iface;
		try {
			// Interface alone warns and skips invalid entries, which could silently omit a selector.
			iface = new Interface(artifact.abi.map(entry => Fragment.from(entry)));
		} catch {
			fail("invalid-artifact", "Release artifact contains an invalid ABI entry");
		}
		const selectors = [];
		for (const fragment of iface.fragments.filter(f => f.type === "function" && f.format("sighash") !== "init(bytes)")) {
			const selector = iface.getFunction(fragment.format("sighash")).selector;
			if (selector === CUT || desired.has(selector)) fail("duplicate-selector", "Release contains a duplicate or reserved selector");
			desired.set(selector, name);
			selectors.push(selector);
		}
		const libraries = [
			...new Set(Object.entries(artifact.linkReferences).flatMap(([file, names]) => Object.keys(names).map(n => `${file}:${n}`))),
		].sort();
		artifacts.push({ name, sha256: spec.facets[index].sha256, selectors: selectors.sort(), libraries });
	}
	const changes = [];
	for (const selector of [...new Set([...current.keys(), ...desired.keys()])].sort()) {
		if (selector === CUT) continue;
		const change = !desired.has(selector) ? "remove" : current.has(selector) ? "replace" : "add";
		if (change === "remove" && !spec.allowedRemovedSelectors.includes(selector))
			fail("unreviewed-removal", `Unreviewed selector removal ${selector}`);
		changes.push({ selector, change, currentFacet: current.get(selector) ?? null, targetArtifact: desired.get(selector) ?? null });
	}
	return validateDocument("plan", {
		schemaVersion: 1,
		kind: "symmio.plan",
		inputDigest,
		snapshotDigest: operationDigest(snapshot),
		operation: "upgrade",
		component: "core",
		target: snapshot.core,
		authority: snapshot.owner,
		executable: false,
		changes,
		artifacts,
		migrations: spec.migrations,
		requiredChecks: [
			"Reproduce the pinned source with the declared compiler settings and verify all linked library artifacts",
			"Verify storage compatibility, economic invariants and each declared migration with a supported release adapter",
			"Review role transitions and maintenance policy against the installed contracts",
			"Deploy or verify replacement addresses and bind exact transaction calldata",
			"Rehearse the complete migration and final payload, then revalidate the chain state before authorization",
			"Execute through the required authority and independently verify receipts and resulting state",
		],
	});
}
