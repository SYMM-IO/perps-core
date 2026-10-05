import { operationDigest } from "./inputs.js";
import { FunctionFragment, Interface, getAddress, keccak256, toBeHex, ZeroAddress } from "ethers";

function fragment(spec) {
	if (!spec || typeof spec.signature !== "string" || !Array.isArray(spec.args))
		throw new Error("Configuration calls need an ABI signature and explicit arguments");
	return FunctionFragment.from(spec.signature);
}
function argument(value, observed) {
	if (Array.isArray(value)) return value.map(item => argument(item, observed));
	if (value && typeof value === "object") {
		if (
			value.ref !== "observed" ||
			Object.keys(value).some(key => !["ref", "path"].includes(key)) ||
			(value.path !== undefined && !Array.isArray(value.path))
		)
			throw new Error("Unknown configuration argument reference");
		let result = observed;
		for (const key of value.path || []) {
			if (!result || !Object.hasOwn(result, key)) throw new Error("Configuration argument path is missing");
			result = result[key];
		}
		return result;
	}
	return value;
}
function normalize(type, value) {
	if (type.baseType === "array") return [...value].map(item => normalize(type.arrayChildren, item));
	if (type.baseType === "tuple")
		return Object.fromEntries(
			type.components.map((component, index) => {
				if (!component.name || type.components.filter(c => c.name === component.name).length !== 1)
					throw new Error("Configuration tuples require unique named ABI components");
				return [component.name, normalize(component, value[index])];
			}),
		);
	if (/^u?int\d+$/.test(type.type)) return String(value);
	if (type.type === "address") return getAddress(value);
	return value;
}
function hasObserved(value) {
	return Array.isArray(value) ? value.some(hasObserved) : value && typeof value === "object" && value.ref === "observed";
}
function hasReference(value) {
	return Array.isArray(value)
		? value.some(hasReference)
		: value && typeof value === "object" && (Object.hasOwn(value, "ref") || Object.values(value).some(hasReference));
}
function outputs(fn, values) {
	if (fn.outputs.length === 1) return normalize(fn.outputs[0], values[0]);
	return Object.fromEntries(
		fn.outputs.map((output, i) => {
			if (!output.name || fn.outputs.filter(o => o.name === output.name).length !== 1)
				throw new Error("Multi-value configuration getters require unique named ABI outputs");
			return [output.name, normalize(output, values[i])];
		}),
	);
}
function implementationBinding(contract) {
	if (!contract?.implementation) return;
	const implementation = contract.implementation;
	address(implementation.address);
	if (![implementation.slot, implementation.codeHash].every(value => /^0x[0-9a-fA-F]{64}$/.test(value)))
		throw new Error("Invalid configuration implementation binding");
}
const address = value => {
	const result = getAddress(value);
	if (result === ZeroAddress) throw new Error("Configuration contract or authority cannot be zero");
	return result;
};
export function validateConfigurationProfile(profile) {
	if (
		profile.schemaVersion !== 1 ||
		profile.kind !== "symmio.configuration-profile" ||
		!Number.isSafeInteger(profile.chainId) ||
		profile.chainId < 1 ||
		!Array.isArray(profile.fields)
	)
		throw new Error("Invalid configuration profile");
	address(profile.source?.address);
	if (!/^0x[0-9a-fA-F]{64}$/.test(profile.source?.codeHash)) throw new Error("Missing configuration source runtime binding");
	implementationBinding(profile.source);
	const ids = new Set();
	for (const field of profile.fields) {
		if (
			!/^[a-z][a-z0-9.-]*$/.test(field.id || "") ||
			ids.has(field.id) ||
			!["copy", "flag", "immutable", "derived", "append"].includes(field.mode)
		)
			throw new Error("Configuration fields need unique IDs and a supported mode");
		ids.add(field.id);
		if (
			field.dependsOn !== undefined &&
			(!Array.isArray(field.dependsOn) ||
				!["copy", "flag"].includes(field.mode) ||
				new Set(field.dependsOn).size !== field.dependsOn.length ||
				field.dependsOn.some(dependency => dependency === field.id || !ids.has(dependency)))
		)
			throw new Error("Configuration dependencies must name earlier fields and use copy or flag mode");
		for (const read of [field.read, field.targetRead || field.read, ...(field.mode === "append" ? [field.cursor?.read] : [])]) {
			const fn = fragment(read);
			if (!["view", "pure"].includes(fn.stateMutability) || fn.outputs.length < 1 || hasReference(read.args))
				throw new Error("Configuration getters require values and literal arguments");
		}
		if (["copy", "flag", "append"].includes(field.mode)) {
			const writes = field.mode === "flag" ? [field.write?.whenTrue, field.write?.whenFalse] : [field.write, ...(field.afterWrite || [])];
			for (const write of writes)
				if (fragment(write).stateMutability !== "nonpayable" || (field.mode !== "flag" && !hasObserved(write.args)))
					throw new Error("Configuration setters must be nonpayable and bind the observed value");
			if (field.mode === "flag" && (fragment(field.read).outputs.length !== 1 || fragment(field.read).outputs[0].type !== "bool"))
				throw new Error("Flag configuration requires a boolean getter");
			address(field.authority?.address);
			const proof = fragment(field.authority.read);
			if (
				!["view", "pure"].includes(proof.stateMutability) ||
				proof.outputs.length !== 1 ||
				!["bool", "address"].includes(proof.outputs[0].type)
			)
				throw new Error("Configuration authority requires a role or owner getter");
			if (
				proof.outputs[0].type === "bool" &&
				!proof.inputs.some(
					(input, i) => input.type === "address" && getAddress(field.authority.read.args[i]) === address(field.authority.address),
				)
			)
				throw new Error("Configuration role proof must bind the configured authority");
		}
		if (field.afterWrite && (!Array.isArray(field.afterWrite) || field.mode !== "append"))
			throw new Error("After-write calls are supported only for append configuration");
		if (
			field.mode === "append" &&
			(!/^(0|[1-9][0-9]*)$/.test(field.cursor.index) ||
				fragment(field.cursor.read).outputs.length !== 1 ||
				fragment(field.cursor.read).outputs[0].type !== "uint256")
		)
			throw new Error("Append configuration requires an explicit index and uint256 cursor");
	}
	return profile;
}
async function blockTag(provider, chainId, checkpoint) {
	if (!Number.isSafeInteger(checkpoint.blockNumber) || checkpoint.blockNumber < 0 || !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.blockHash))
		throw new Error("Invalid configuration checkpoint");
	const tag = toBeHex(checkpoint.blockNumber),
		block = await provider.send("eth_getBlockByNumber", [tag, false]);
	if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId) || block?.hash?.toLowerCase() !== checkpoint.blockHash.toLowerCase())
		throw new Error("Configuration checkpoint changed");
	return tag;
}
async function runtime(provider, contract, tag) {
	address(contract.address);
	const code = await provider.send("eth_getCode", [contract.address, tag]);
	if (code === "0x" || keccak256(code) !== contract.codeHash?.toLowerCase()) throw new Error("Configuration runtime changed");
	implementationBinding(contract);
	if (contract.implementation) {
		const implementation = contract.implementation;
		if (BigInt(await provider.send("eth_getStorageAt", [contract.address, implementation.slot, tag])) !== BigInt(address(implementation.address)))
			throw new Error("Configuration implementation changed");
		const code = await provider.send("eth_getCode", [implementation.address, tag]);
		if (code === "0x" || keccak256(code) !== implementation.codeHash.toLowerCase())
			throw new Error("Configuration implementation runtime changed");
	}
}
async function read(provider, target, spec, tag) {
	const fn = fragment(spec),
		iface = new Interface([fn]);
	const result = iface.decodeFunctionResult(
		fn,
		await provider.send("eth_call", [{ to: address(target), data: iface.encodeFunctionData(fn, spec.args) }, tag]),
	);
	return outputs(fn, result);
}
async function authority(provider, target, proof, tag) {
	const result = await read(provider, target, proof.read, tag);
	if (result !== true && result !== address(proof.address)) throw new Error("Configuration authority differs");
}

/** Only the release profile's declared configuration getters are read; no user-state discovery. */
export async function captureConfigurationSnapshot(provider, profile, checkpoint) {
	validateConfigurationProfile(profile);
	const tag = await blockTag(provider, profile.chainId, checkpoint);
	await runtime(provider, profile.source, tag);
	const fields = [];
	for (const field of profile.fields) {
		const value = await read(provider, profile.source.address, field.read, tag);
		if (Object.hasOwn(field, "expectedValue") && operationDigest(value) !== operationDigest(field.expectedValue))
			throw new Error(`Supplied configuration differs: ${field.id}`);
		fields.push({ id: field.id, value });
	}
	await blockTag(provider, profile.chainId, checkpoint);
	return {
		schemaVersion: 1,
		kind: "symmio.configuration-snapshot",
		profileDigest: operationDigest(profile),
		source: profile.source,
		checkpoint,
		fields,
	};
}

/** Build exact, authority-bound setters. Existing append entries must match; only missing indices are created. */
export async function buildConfigurationMigration(provider, profile, snapshot, target, checkpoint) {
	validateConfigurationProfile(profile);
	if (
		snapshot.kind !== "symmio.configuration-snapshot" ||
		snapshot.profileDigest !== operationDigest(profile) ||
		!Array.isArray(snapshot.fields) ||
		snapshot.fields.length !== profile.fields.length ||
		new Set(snapshot.fields.map(field => field.id)).size !== profile.fields.length
	)
		throw new Error("Configuration snapshot binding changed");
	if (operationDigest(await captureConfigurationSnapshot(provider, profile, snapshot.checkpoint)) !== operationDigest(snapshot))
		throw new Error("Configuration snapshot differs from its pinned source");
	const currentSource = await captureConfigurationSnapshot(provider, profile, checkpoint);
	if (operationDigest(currentSource.fields) !== operationDigest(snapshot.fields))
		throw new Error("Configuration source changed since the reviewed snapshot");
	const tag = await blockTag(provider, profile.chainId, checkpoint);
	await runtime(provider, target, tag);
	const actions = [],
		checks = [],
		changed = new Set(),
		cursors = new Map();
	for (const field of profile.fields) {
		const observed = snapshot.fields.find(item => item.id === field.id);
		if (!observed) throw new Error("Configuration snapshot is incomplete");
		const spec = field.targetRead || field.read;
		checks.push({ id: field.id, read: spec, expected: observed.value });
		if (field.mode === "derived") continue;
		let current;
		if (field.mode === "append") {
			const key = operationDigest(field.cursor.read);
			if (!cursors.has(key)) cursors.set(key, BigInt(await read(provider, target.address, field.cursor.read, tag)));
			const index = BigInt(field.cursor.index),
				count = cursors.get(key);
			if (index < count) {
				current = await read(provider, target.address, spec, tag);
				if (operationDigest(current) !== operationDigest(observed.value))
					throw new Error(`Existing append configuration differs: ${field.id}`);
				continue;
			}
			if (index !== count) throw new Error("Append configuration indices must be contiguous");
			cursors.set(key, count + 1n);
		} else {
			current = await read(provider, target.address, spec, tag);
			if (operationDigest(current) === operationDigest(observed.value) && !(field.dependsOn || []).some(dependency => changed.has(dependency)))
				continue;
			if (field.mode === "immutable") throw new Error(`Configuration immutable differs: ${field.id}`);
		}
		await authority(provider, target.address, field.authority, tag);
		changed.add(field.id);
		const writes = field.mode === "flag" ? [field.write[observed.value ? "whenTrue" : "whenFalse"]] : [field.write, ...(field.afterWrite || [])];
		for (const [index, write] of writes.entries()) {
			const fn = fragment(write),
				iface = new Interface([fn]),
				args = write.args.map(value => argument(value, observed.value));
			actions.push({
				id: index === 0 ? field.id : `${field.id}.after-${index}`,
				to: address(target.address),
				value: "0",
				authority: address(field.authority.address),
				data: iface.encodeFunctionData(fn, args),
				description: `Copy configuration ${field.id}`,
			});
		}
	}
	await blockTag(provider, profile.chainId, checkpoint);
	const plan = {
		schemaVersion: 1,
		kind: "symmio.configuration-migration",
		chainId: profile.chainId,
		profileDigest: operationDigest(profile),
		snapshotDigest: operationDigest(snapshot),
		target,
		checkpoint,
		actions,
		checks,
	};
	return { ...plan, planDigest: operationDigest(plan) };
}

export async function verifyConfigurationMigration(provider, plan, checkpoint) {
	const { planDigest, ...content } = plan;
	if (operationDigest(content) !== planDigest) throw new Error("Configuration plan changed");
	const tag = await blockTag(provider, plan.chainId, checkpoint);
	await runtime(provider, plan.target, tag);
	for (const check of plan.checks)
		if (operationDigest(await read(provider, plan.target.address, check.read, tag)) !== operationDigest(check.expected))
			throw new Error(`Configuration post-state differs: ${check.id}`);
	await blockTag(provider, plan.chainId, checkpoint);
	return { planDigest, checkpoint, fields: plan.checks.length };
}
