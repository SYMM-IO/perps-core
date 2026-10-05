import { operationDigest } from "./inputs.js";
import { FunctionFragment, Interface, getAddress, keccak256, toBeHex, ZeroAddress } from "ethers";

const address = value => {
	const result = getAddress(value);
	if (result === ZeroAddress) throw new Error("Wiring address cannot be zero");
	return result;
};
function abiCall(spec, context) {
	if (!spec || typeof spec.signature !== "string") throw new Error("Missing wiring ABI call");
	const fragment = FunctionFragment.from(spec.signature),
		iface = new Interface([fragment]);
	const resolve = value => {
		if (Array.isArray(value)) return value.map(resolve);
		if (value && typeof value === "object") {
			if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "ref") || !Object.hasOwn(context, value.ref))
				throw new Error("Unknown wiring argument reference");
			return context[value.ref];
		}
		return value;
	};
	if (!Array.isArray(spec.args)) throw new Error("Wiring calls require explicit named-ABI arguments");
	return { fragment, iface, data: iface.encodeFunctionData(fragment, spec.args.map(resolve)) };
}
function requireReferences(spec, allowed, required) {
	const refs = [];
	const visit = value => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") refs.push(value.ref);
	};
	spec.args.forEach(visit);
	if (refs.some(ref => !allowed.includes(ref)) || (required && !refs.includes(required)))
		throw new Error("Wiring call does not bind the required argument reference");
}
function validateBindings(profile) {
	if (profile.schemaVersion !== 1 || !Number.isSafeInteger(profile.chainId) || profile.chainId <= 0 || !Array.isArray(profile.bindings))
		throw new Error("Invalid wiring profile");
	const ids = new Set();
	for (const binding of profile.bindings) {
		if (
			!/^[a-z][a-z0-9.-]*$/.test(binding.id || "") ||
			ids.has(binding.id) ||
			!/^[a-z][a-z0-9-]*$/.test(binding.dependency || "") ||
			!binding.consumer ||
			!binding.authority
		)
			throw new Error("Wiring bindings need unique IDs, a dependency, a consumer and an authority");
		ids.add(binding.id);
		address(binding.consumer.address);
		address(binding.source);
		address(binding.authority.address);
		if (!/^0x[0-9a-fA-F]{64}$/.test(binding.consumer.codeHash)) throw new Error("Missing consumer runtime binding");
		if (binding.consumer.implementation) {
			const implementation = binding.consumer.implementation;
			address(implementation.address);
			if (![implementation.slot, implementation.codeHash].every(value => /^0x[0-9a-fA-F]{64}$/.test(value)))
				throw new Error("Invalid consumer implementation binding");
		}
		if (!["address", "membership"].includes(binding.kind)) throw new Error("Unsupported wiring migration kind");
		const context = {
			source: binding.source,
			replacement: binding.source,
			observed: binding.kind === "membership" ? true : binding.source,
			authority: binding.authority.address,
		};
		for (const read of [binding.read, binding.authority.read]) {
			const call = abiCall(read, context);
			if (!["view", "pure"].includes(call.fragment.stateMutability) || call.fragment.outputs.length !== 1)
				throw new Error("Wiring and authority checks require single-value read functions");
		}
		if (abiCall(binding.read, context).fragment.outputs[0].type !== (binding.kind === "membership" ? "bool" : "address"))
			throw new Error("Wiring getter output differs from its migration kind");
		const authorityType = abiCall(binding.authority.read, context).fragment.outputs[0].type;
		if (!["bool", "address"].includes(authorityType)) throw new Error("Authority proof must return an address or role membership");
		requireReferences(binding.read, ["source"], binding.kind === "membership" ? "source" : undefined);
		requireReferences(binding.authority.read, ["authority"], authorityType === "bool" ? "authority" : undefined);
		if (binding.kind === "membership" && !binding.clear) throw new Error("Membership replacement requires explicit source retirement");
		if (binding.kind === "address" && binding.clear) throw new Error("Address references are retired by their replacement setter");
		for (const write of [binding.set, binding.clear].filter(Boolean)) {
			const call = abiCall(write, context);
			if (call.fragment.stateMutability !== "nonpayable") throw new Error("Wiring setters must be nonpayable");
		}
		requireReferences(binding.set, ["replacement", "observed", "authority"], "replacement");
		if (binding.clear) requireReferences(binding.clear, ["source", "observed", "authority"], "source");
	}
	return profile;
}
async function verifyConsumer(provider, consumer, tag) {
	const code = await provider.send("eth_getCode", [address(consumer.address), tag]);
	if (code === "0x" || keccak256(code) !== consumer.codeHash.toLowerCase()) throw new Error("Wiring consumer runtime changed");
	if (consumer.implementation) {
		const implementation = consumer.implementation;
		const stored = await provider.send("eth_getStorageAt", [address(consumer.address), implementation.slot, tag]);
		if (BigInt(stored) !== BigInt(address(implementation.address))) throw new Error("Wiring consumer implementation changed");
		const runtime = await provider.send("eth_getCode", [address(implementation.address), tag]);
		if (runtime === "0x" || keccak256(runtime) !== implementation.codeHash.toLowerCase())
			throw new Error("Wiring consumer implementation runtime changed");
	}
}
async function verifyAuthority(provider, consumer, authority, tag) {
	const expected = address(authority.address);
	const observed = await readValue(provider, consumer.address, authority.read, { authority: expected }, tag);
	if (observed !== true && observed !== expected) throw new Error("Wiring authority differs");
}
async function readValue(provider, consumer, spec, context, blockTag) {
	const { iface, fragment, data } = abiCall(spec, context);
	const result = await provider.send("eth_call", [{ to: address(consumer), data }, blockTag]);
	const value = iface.decodeFunctionResult(fragment, result)[0];
	return fragment.outputs[0].type === "address" ? address(value) : value;
}

/** Read-only, block-pinned discovery of actual pointers, optional permissions and their authorities. */
export async function captureWiringSnapshot(provider, profile, checkpoint) {
	validateBindings(profile);
	if (!Number.isSafeInteger(checkpoint.blockNumber) || checkpoint.blockNumber < 0 || !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.blockHash))
		throw new Error("Invalid wiring checkpoint");
	const tag = toBeHex(checkpoint.blockNumber),
		block = await provider.send("eth_getBlockByNumber", [tag, false]);
	if (
		BigInt(await provider.send("eth_chainId", [])) !== BigInt(profile.chainId) ||
		!block ||
		block.hash.toLowerCase() !== checkpoint.blockHash.toLowerCase()
	)
		throw new Error("Wiring checkpoint chain or block changed");
	const observations = [];
	for (const binding of profile.bindings) {
		const context = { source: address(binding.source), authority: address(binding.authority.address) };
		await verifyConsumer(provider, binding.consumer, tag);
		await verifyAuthority(provider, binding.consumer, binding.authority, tag);
		const observed = await readValue(provider, binding.consumer.address, binding.read, context, tag);
		if (binding.kind === "address" && observed !== context.source) throw new Error(`Wiring source pointer differs: ${binding.id}`);
		observations.push({ id: binding.id, observed });
	}
	if ((await provider.send("eth_getBlockByNumber", [tag, false]))?.hash?.toLowerCase() !== block.hash.toLowerCase())
		throw new Error("Wiring checkpoint reorged");
	return {
		schemaVersion: 1,
		profileDigest: operationDigest(profile),
		chainId: profile.chainId,
		blockNumber: checkpoint.blockNumber,
		blockHash: block.hash.toLowerCase(),
		observations,
	};
}

/** Produces exact governance calls; inactive source memberships remain inactive at the replacement. */
export function buildWiringMigration(profile, snapshot, replacements) {
	validateBindings(profile);
	if (snapshot.schemaVersion !== 1 || snapshot.profileDigest !== operationDigest(profile) || snapshot.chainId !== profile.chainId)
		throw new Error("Wiring snapshot binding changed");
	if (snapshot.observations.length !== profile.bindings.length || new Set(snapshot.observations.map(o => o.id)).size !== profile.bindings.length)
		throw new Error("Wiring observations are incomplete or duplicated");
	const retire = [],
		activate = [],
		checks = [];
	for (const binding of profile.bindings) {
		const observation = snapshot.observations.find(o => o.id === binding.id);
		if (
			!observation ||
			(binding.kind === "membership" ? typeof observation.observed !== "boolean" : observation.observed !== address(binding.source))
		)
			throw new Error("Invalid wiring observation");
		const replacement = address(replacements[binding.dependency]),
			source = address(binding.source),
			observed = observation.observed;
		const context = { source, replacement, observed, authority: address(binding.authority.address) };
		const action = (spec, phase) => ({
			id: `${binding.id}.${phase}`,
			to: address(binding.consumer.address),
			value: "0",
			data: abiCall(spec, context).data,
			authority: context.authority,
			description: `${phase} ${binding.id}`,
		});
		if (source !== replacement && (binding.kind === "address" || observed)) {
			activate.push(action(binding.set, "activate"));
			if (binding.clear) retire.push(action(binding.clear, "retire"));
		}
		checks.push({
			id: `${binding.id}.replacement`,
			to: address(binding.consumer.address),
			spec: binding.read,
			context: { ...context, source: replacement },
			expected: binding.kind === "address" ? replacement : observed,
		});
		if (binding.kind === "membership" && source !== replacement)
			checks.push({ id: `${binding.id}.retired`, to: address(binding.consumer.address), spec: binding.read, context, expected: false });
	}
	const consumers = profile.bindings.map(binding => ({ id: binding.id, consumer: binding.consumer, authority: binding.authority }));
	const result = {
		schemaVersion: 1,
		chainId: profile.chainId,
		profileDigest: operationDigest(profile),
		snapshotDigest: operationDigest(snapshot),
		replacements,
		consumers,
		retire,
		activate,
		checks,
	};
	return { ...result, planDigest: operationDigest(result) };
}

export async function verifyWiringMigration(provider, plan, checkpoint) {
	const { planDigest, ...content } = plan;
	if (operationDigest(content) !== planDigest) throw new Error("Wiring plan changed");
	if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(plan.chainId)) throw new Error("Wiring verification chain changed");
	const tag = toBeHex(checkpoint.blockNumber),
		block = await provider.send("eth_getBlockByNumber", [tag, false]);
	if (!block || block.hash.toLowerCase() !== checkpoint.blockHash.toLowerCase()) throw new Error("Wiring verification block changed");
	for (const { consumer, authority } of plan.consumers) {
		await verifyConsumer(provider, consumer, tag);
		await verifyAuthority(provider, consumer, authority, tag);
	}
	for (const check of plan.checks)
		if ((await readValue(provider, check.to, check.spec, check.context, tag)) !== check.expected)
			throw new Error(`Wiring post-state differs: ${check.id}`);
	if ((await provider.send("eth_getBlockByNumber", [tag, false]))?.hash?.toLowerCase() !== block.hash.toLowerCase())
		throw new Error("Wiring verification reorged");
	return { planDigest, blockNumber: checkpoint.blockNumber, blockHash: block.hash.toLowerCase(), checks: plan.checks.length };
}
