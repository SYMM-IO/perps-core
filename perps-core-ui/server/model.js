import { Interface, ZeroAddress, getAddress, keccak256 } from "ethers";
import { createHash } from "node:crypto";

export const CUT_ABI = ["function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes data)"];
export const CUT_SELECTOR = "0x1f931c1c";
export const LOUPE_SELECTOR = "0x7a0ed627";
export const protectedSelectors = new Set([CUT_SELECTOR, LOUPE_SELECTOR]);
export const canonical = value =>
	JSON.stringify(value, (_key, item) =>
		typeof item === "bigint"
			? item.toString()
			: item && typeof item === "object" && !Array.isArray(item)
				? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
				: item,
	);
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
export const codeHash = code => keccak256(code);
export function address(value) {
	const result = getAddress(value);
	if (result === ZeroAddress) throw new Error("A non-zero address is required");
	return result;
}
export function selectors(abi) {
	const result = {};
	new Interface(abi).forEachFunction(fragment => {
		result[fragment.selector] = fragment.format("sighash");
	});
	return result;
}
export function selectorMap(facets) {
	const result = {};
	for (const facet of facets)
		for (const selector of facet.selectors) {
			if (!/^0x[\da-f]{8}$/i.test(selector) || result[selector.toLowerCase()]) throw new Error(`Invalid or duplicate selector ${selector}`);
			result[selector.toLowerCase()] = address(facet.address);
		}
	return result;
}

/** Patch mode NEVER removes an omitted selector. Reconcile removals require an exact acknowledgment set. */
export function planSelectors(current, candidates, { mode = "patch", removals = [] } = {}) {
	if (!["patch", "reconcile"].includes(mode)) throw new Error("Choose patch or reconcile mode");
	const desired = {},
		names = {},
		signatures = {};
	for (const candidate of candidates)
		for (const [selector, signature] of Object.entries(candidate.selectors)) {
			if (desired[selector]) throw new Error(`Selector collision ${selector}: ${names[selector]} and ${candidate.name}`);
			desired[selector] = candidate.address;
			names[selector] = candidate.name;
			signatures[selector] = signature;
		}
	const removed = [...new Set(removals.map(s => s.toLowerCase()))].sort();
	for (const selector of removed) {
		if (!current[selector]) throw new Error(`Cannot remove missing selector ${selector}`);
		if (protectedSelectors.has(selector)) throw new Error(`Cannot remove upgrade/introspection selector ${selector}`);
		if (desired[selector]) throw new Error(`Selector ${selector} is both included and removed`);
	}
	if (mode === "reconcile") {
		const expected = Object.keys(current)
			.filter(s => !desired[s] && !protectedSelectors.has(s))
			.sort();
		if (canonical(expected) !== canonical(removed))
			throw new Error(`Review and explicitly select all ${expected.length} removed selectors before reconciling`);
	}
	const finalMap = { ...current },
		changes = [];
	for (const [selector, to] of Object.entries(desired).sort()) {
		if (current[selector]?.toLowerCase() === to.toLowerCase()) continue;
		changes.push({
			selector,
			signature: signatures[selector],
			name: names[selector],
			action: current[selector] ? "replace" : "add",
			from: current[selector] || null,
			to,
		});
		finalMap[selector] = to;
	}
	for (const selector of removed) {
		changes.push({ selector, action: "remove", from: current[selector], to: null });
		delete finalMap[selector];
	}
	return { changes, finalMap };
}
export function encodeCut(changes) {
	const groups = new Map();
	for (const change of changes) {
		const action = { add: 0, replace: 1, remove: 2 }[change.action];
		const facetAddress = change.to ? address(change.to) : ZeroAddress;
		const key = `${action}:${facetAddress}`;
		if (!groups.has(key)) groups.set(key, { facetAddress, action, functionSelectors: [] });
		groups.get(key).functionSelectors.push(change.selector);
	}
	return new Interface(CUT_ABI).encodeFunctionData("diamondCut", [[...groups.values()], ZeroAddress, "0x"]);
}
export function linkBytecode(bytecode, references, addresses) {
	let result = bytecode.slice(2);
	for (const [source, libraries] of Object.entries(references || {}))
		for (const [name, positions] of Object.entries(libraries)) {
			const linked = address(addresses[`${source}:${name}`] || addresses[name])
				.slice(2)
				.toLowerCase();
			for (const { start, length } of positions) {
				if (length !== 20) throw new Error(`Unsupported link width for ${name}`);
				result = result.slice(0, start * 2) + linked + result.slice((start + length) * 2);
			}
		}
	if (!/^[\da-f]*$/i.test(result)) throw new Error("Unresolved library links");
	return `0x${result}`;
}
export function runtimeTemplate(artifact, deployedAddress) {
	let result = artifact.deployedBytecode;
	for (const [name, positions] of Object.entries(artifact.immutableReferences || {})) {
		if (artifact.kind !== "library" || name !== "library_deploy_address" || !deployedAddress) throw new Error(`Unresolved immutable ${name}`);
		for (const { start, length } of positions) {
			if (![20, 32].includes(length)) throw new Error("Unsupported library self-address width");
			const value = address(deployedAddress)
				.slice(2)
				.toLowerCase()
				.padStart(length * 2, "0");
			result = result.slice(0, 2 + start * 2) + value + result.slice(2 + (start + length) * 2);
		}
	}
	return result;
}
export const runtimeBytecode = (artifact, links, deployedAddress) =>
	linkBytecode(runtimeTemplate(artifact, deployedAddress), artifact.deployedLinkReferences, links);
export function matchRuntime(artifact, code, deployedAddress) {
	if (!code || code === "0x" || code.length !== artifact.deployedBytecode.length) return null;
	let template;
	try {
		template = runtimeTemplate(artifact, deployedAddress);
	} catch {
		return null;
	}
	const links = {};
	for (const [source, libraries] of Object.entries(artifact.deployedLinkReferences || {}))
		for (const [name, positions] of Object.entries(libraries)) {
			for (const { start, length } of positions) {
				if (length !== 20) return null;
				const found = getAddress(`0x${code.slice(2 + start * 2, 2 + (start + length) * 2)}`);
				if (links[`${source}:${name}`] && links[`${source}:${name}`] !== found) return null;
				links[`${source}:${name}`] = found;
			}
		}
	try {
		return linkBytecode(template, artifact.deployedLinkReferences, links).toLowerCase() === code.toLowerCase() ? links : null;
	} catch {
		return null;
	}
}
export function assertIntentTransaction(tx, request, sender) {
	if (
		!tx ||
		address(tx.from) !== address(sender) ||
		(tx.to || "").toLowerCase() !== (request.to || "").toLowerCase() ||
		tx.data.toLowerCase() !== request.data.toLowerCase() ||
		BigInt(tx.value) !== BigInt(request.value || 0) ||
		Number(tx.nonce) !== Number(request.nonce) ||
		BigInt(tx.chainId) !== BigInt(request.chainId)
	) {
		throw new Error("Transaction does not match the reviewed sender, nonce, chain, target, value, and calldata");
	}
}

/** Who a plan is for. A profile that names a different chain, or none, gives a custom identity that still carries the chain. */
export function deploymentIdentity(profile, chainId) {
	if (!profile || profile.chainId !== chainId || !profile.id || profile.id === "custom")
		return { id: `custom-${chainId}`, name: "Custom target", environment: "Custom", chainId };
	return { id: String(profile.id), name: String(profile.name || profile.id), environment: String(profile.environment || "Custom"), chainId };
}
/** The text an operator types to execute a plan. Plans saved before deployment identity fall back to the chain id. */
export const executionConfirmation = (planId, deployment, chainId) => `${deployment?.id ?? chainId}:${planId.slice(0, 8)}`;
export const rehearsalState = record => (["passed", "failed"].includes(record?.rehearsal?.status) ? record.rehearsal.status : "none");
/** Transaction outcomes in a plan's journal: confirmed, broadcast without a receipt yet, and intents whose wallet outcome is unknown. */
export function journalCounts(journal = {}) {
	const counts = { confirmed: 0, submitted: 0, unresolved: 0, failed: 0 };
	for (const j of Object.values(journal || {})) {
		if (j.status === "confirmed") counts.confirmed++;
		else if (j.status === "failed") counts.failed++;
		else if (j.hash) counts.submitted++;
		else counts.unresolved++;
	}
	return counts;
}
