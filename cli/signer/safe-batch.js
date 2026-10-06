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

export function validateSafeBatchTransport(batch) {
	if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new Error("Safe batch must be an object");
	const normalizedActions = validateSafeActions(batch.actions);
	const transactionBuilder = batch.transactionBuilder;
	if (!transactionBuilder || typeof transactionBuilder !== "object" || Array.isArray(transactionBuilder)) {
		throw new Error("Safe batch requires a Transaction Builder document");
	}
	if (transactionBuilder.chainId !== String(batch.chainId)) throw new Error("Safe Transaction Builder chain ID differs from reviewed intent");
	if (transactionBuilder.meta?.createdFromSafeAddress !== batch.safeAddress) {
		throw new Error("Safe Transaction Builder address differs from reviewed intent");
	}
	if (!Array.isArray(transactionBuilder.transactions) || transactionBuilder.transactions.length !== normalizedActions.length) {
		throw new Error("Safe Transaction Builder action count differs from reviewed intent");
	}
	for (const [index, action] of normalizedActions.entries()) {
		const transaction = transactionBuilder.transactions[index];
		if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
			throw new Error(`Safe Transaction Builder action ${index + 1} must be an object`);
		}
		if (transaction.to !== action.to) throw new Error(`Safe Transaction Builder action ${index + 1} target differs from reviewed intent`);
		if (transaction.value !== action.value) throw new Error(`Safe Transaction Builder action ${index + 1} value differs from reviewed intent`);
		if (transaction.data !== action.data) {
			throw new Error(`Safe Transaction Builder action ${index + 1} calldata differs from reviewed intent`);
		}
		if (transaction.contractMethod !== null || transaction.contractInputsValues !== null) {
			throw new Error(`Safe Transaction Builder action ${index + 1} must use byte-exact raw calldata`);
		}
	}
	return batch;
}

export function createSafeBatch({ chainId, safeAddress, name, description, actions, createdAt = Date.now() }) {
	if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) < 1) throw new Error(`Invalid Safe batch chain ID ${JSON.stringify(chainId)}`);
	if (!isAddress(safeAddress) || /^0x0{40}$/i.test(safeAddress)) throw new Error("Safe batch requires a non-zero Safe address");
	const normalizedActions = validateSafeActions(actions);
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
		transactions: normalizedActions.map(action => ({
			to: action.to,
			value: action.value,
			data: action.data,
			contractMethod: null,
			contractInputsValues: null,
		})),
	};
	const intent = {
		apiVersion: BATCH_API_VERSION,
		chainId: Number(chainId),
		safeAddress: getAddress(safeAddress),
		name,
		description: description || "",
		actions: normalizedActions,
	};
	return validateSafeBatchTransport({ ...intent, transactionBuilder, digest: safeBatchDigest(intent) });
}

export function writeSafeBatch(file, batch) {
	validateSafeBatchTransport(batch);
	atomicWrite(file, batch.transactionBuilder);
	const written = JSON.parse(fs.readFileSync(file, "utf8"));
	validateSafeBatchTransport({ ...batch, transactionBuilder: written });
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
