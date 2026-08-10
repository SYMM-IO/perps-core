import { Interface, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BATCH_API_VERSION = "operations.symm.io/safe-batch-v1";
const TRANSACTION_BUILDER_VERSION = "2.0.1";

function stableValue(value) {
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(stableValue);
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map(key => [key, stableValue(value[key])]),
	);
}

export function safeBatchDigest(value) {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

function atomicWrite(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function artifactFiles(root) {
	const directory = path.join(root, "artifacts", "contracts");
	if (!fs.existsSync(directory)) return [];
	const result = [];
	const visit = entry => {
		const stat = fs.statSync(entry);
		if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entry).sort()) visit(path.join(entry, child));
		} else if (stat.isFile() && entry.endsWith(".json") && !entry.endsWith(".dbg.json")) result.push(entry);
	};
	visit(directory);
	return result;
}

function loadInterfaces(root) {
	const result = [];
	for (const file of artifactFiles(root)) {
		try {
			const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!Array.isArray(artifact.abi)) continue;
			result.push(new Interface(artifact.abi));
		} catch {}
	}
	return result;
}

function jsonInputValue(value) {
	const stable = stableValue(value);
	if (Array.isArray(stable) || (stable && typeof stable === "object")) return JSON.stringify(stable);
	return String(stable);
}

function methodForAction(action, interfaces) {
	if (action.data === "0x" || action.data.length < 10) return null;
	const matches = new Map();
	for (const candidate of interfaces) {
		let fragment;
		try {
			fragment = candidate.getFunction(action.data.slice(0, 10));
			if (!fragment) continue;
			const decoded = candidate.decodeFunctionData(fragment, action.data);
			const contractInputsValues = {};
			fragment.inputs.forEach((input, index) => {
				contractInputsValues[input.name || `arg${index}`] = jsonInputValue(decoded[index]);
			});
			matches.set(fragment.format("sighash"), {
				contractMethod: {
					inputs: fragment.inputs.map(input => ({
						internalType: input.type,
						name: input.name,
						type: input.type,
					})),
					name: fragment.name,
					payable: fragment.payable,
				},
				contractInputsValues,
			});
		} catch {}
	}
	return matches.size === 1 ? [...matches.values()][0] : null;
}

export function validateSafeActions(actions) {
	if (!Array.isArray(actions) || actions.length === 0) throw new Error("Safe action batch must contain at least one transaction");
	return actions.map((action, index) => {
		if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error(`Safe action ${index + 1} must be an object`);
		if (!isAddress(action.to) || /^0x0{40}$/i.test(action.to)) throw new Error(`Safe action ${index + 1} has an invalid target`);
		if (typeof action.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(action.data)) {
			throw new Error(`Safe action ${index + 1} has invalid calldata`);
		}
		const value = BigInt(action.value ?? 0).toString();
		if (typeof action.description !== "string" || action.description.trim() === "") {
			throw new Error(`Safe action ${index + 1} requires a description`);
		}
		return { to: getAddress(action.to), value, data: action.data.toLowerCase(), description: action.description.trim() };
	});
}

export function createSafeBatch({ root, chainId, safeAddress, name, description, actions, createdAt = Date.now() }) {
	if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) < 1) throw new Error(`Invalid Safe batch chain ID ${JSON.stringify(chainId)}`);
	if (!isAddress(safeAddress) || /^0x0{40}$/i.test(safeAddress)) throw new Error("Safe batch requires a non-zero Safe address");
	const normalizedActions = validateSafeActions(actions);
	const interfaces = loadInterfaces(root);
	const transactionBuilder = {
		version: "1.0",
		chainId: String(chainId),
		createdAt,
		meta: {
			name,
			description: description || normalizedActions.map(action => action.description).join("; "),
			txBuilderVersion: TRANSACTION_BUILDER_VERSION,
			createdFromSafeAddress: getAddress(safeAddress),
			createdFromOwnerAddress: "",
		},
		transactions: normalizedActions.map(action => {
			const decoded = methodForAction(action, interfaces);
			return {
				to: action.to,
				value: action.value,
				data: decoded ? null : action.data,
				contractMethod: decoded?.contractMethod || null,
				contractInputsValues: decoded?.contractInputsValues || null,
			};
		}),
	};
	const intent = {
		apiVersion: BATCH_API_VERSION,
		chainId: Number(chainId),
		safeAddress: getAddress(safeAddress),
		name,
		description: description || "",
		actions: normalizedActions,
	};
	return { ...intent, transactionBuilder, digest: safeBatchDigest(intent) };
}

export function writeSafeBatch(file, batch) {
	atomicWrite(file, batch.transactionBuilder);
	return file;
}

export function writeSafeIntent(file, batch) {
	atomicWrite(file, {
		apiVersion: batch.apiVersion,
		chainId: batch.chainId,
		safeAddress: batch.safeAddress,
		name: batch.name,
		description: batch.description,
		digest: batch.digest,
		actions: batch.actions,
	});
	return file;
}

export function ownershipAcceptanceAction(to, label) {
	const iface = new Interface(["function acceptOwnership()"]);
	return { to: getAddress(to), value: "0", data: iface.encodeFunctionData("acceptOwnership"), description: `Accept ${label} ownership` };
}

export function roleGrantAction(to, role, holder, label = "role") {
	const iface = new Interface(["function grantRole(bytes32 role,address account)"]);
	return {
		to: getAddress(to),
		value: "0",
		data: iface.encodeFunctionData("grantRole", [keccak256(toUtf8Bytes(role)), getAddress(holder)]),
		description: `Grant ${role} on ${label} to ${getAddress(holder)}`,
	};
}

export { BATCH_API_VERSION };
