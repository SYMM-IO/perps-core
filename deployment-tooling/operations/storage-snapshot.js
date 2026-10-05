import { operationDigest } from "./inputs.js";
import { createMPT, verifyMPTWithMerkleProof } from "@ethereumjs/mpt";
import { AbiCoder, concat, decodeRlp, encodeRlp, getAddress, getBytes, hexlify, keccak256, toBeHex, ZeroAddress, ZeroHash } from "ethers";

const abi = AbiCoder.defaultAbiCoder();
const word = (value, label) => {
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}: expected bytes32`);
	return value.toLowerCase();
};
const integer = (value, label, minimum = 0) => {
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}: expected safe integer`);
	return value;
};
function normalizeSource(source) {
	const address = getAddress(source.address);
	if (address === ZeroAddress) throw new Error("Invalid source address");
	return {
		chainId: integer(source.chainId, "chain ID", 1),
		address,
		blockNumber: integer(source.blockNumber, "block number"),
		blockHash: word(source.blockHash, "block hash"),
		stateRoot: word(source.stateRoot, "state root"),
		codeHash: word(source.codeHash, "code hash"),
		storageRoot: word(source.storageRoot, "storage root"),
	};
}
function normalizeEntries(entries) {
	if (!Array.isArray(entries)) throw new Error("Storage entries must be an array");
	const slots = new Set();
	return entries
		.map(entry => {
			const slot = word(entry.slot, "storage slot"),
				value = word(entry.value, "storage value");
			if (slots.has(slot)) throw new Error("Duplicate storage slot");
			if (value === ZeroHash) throw new Error("Zero storage values must be omitted from a complete trie snapshot");
			slots.add(slot);
			return { slot, value };
		})
		.sort((a, b) => a.slot.localeCompare(b.slot));
}

/** Verifies the account against a supplied block state root. Canonical block provenance belongs to the RPC reader. */
export async function verifyStorageAccount(source, accountProof) {
	const normalized = normalizeSource(source);
	if (!Array.isArray(accountProof) || !accountProof.length) throw new Error("Missing source account proof");
	let account;
	try {
		const trie = await createMPT({ useKeyHashing: true });
		const encoded = await verifyMPTWithMerkleProof(
			trie,
			getBytes(normalized.stateRoot),
			getBytes(normalized.address),
			accountProof.map(getBytes),
		);
		if (!encoded) throw new Error("Absent account");
		account = decodeRlp(encoded);
	} catch {
		throw new Error("Source account proof does not match the pinned state root and address");
	}
	if (!Array.isArray(account) || account.length !== 4 || account[2] !== normalized.storageRoot || account[3] !== normalized.codeHash)
		throw new Error("Source storage root or code hash does not match the account proof");
	return normalized;
}

/** Rebuilds the entire secure storage trie, including nonenumerable mapping entries. Partial inventories fail closed. */
export async function buildStorageSnapshot(source, entries, accountProof) {
	const normalized = await verifyStorageAccount(source, accountProof),
		values = normalizeEntries(entries);
	const trie = await createMPT({ useKeyHashing: true });
	for (const { slot, value } of values) await trie.put(getBytes(slot), getBytes(encodeRlp(toBeHex(BigInt(value)))));
	if (hexlify(trie.root()) !== normalized.storageRoot) throw new Error("Storage inventory is not complete for the pinned source root");
	return { schemaVersion: 1, source: normalized, accountProof: accountProof.map(p => hexlify(getBytes(p))), entries: values };
}

/** Takes roots and code from one historical RPC checkpoint, never from operator-supplied metadata. */
export async function readStorageSnapshot(provider, checkpoint, entries) {
	const chainId = integer(checkpoint.chainId, "chain ID", 1),
		blockNumber = integer(checkpoint.blockNumber, "block number"),
		blockHash = word(checkpoint.blockHash, "block hash"),
		address = getAddress(checkpoint.address);
	const tag = toBeHex(blockNumber);
	const [network, block, proof, code] = await Promise.all([
		provider.send("eth_chainId", []),
		provider.send("eth_getBlockByNumber", [tag, false]),
		provider.send("eth_getProof", [address, [], tag]),
		provider.send("eth_getCode", [address, tag]),
	]);
	if (BigInt(network) !== BigInt(chainId) || !block || block.hash?.toLowerCase() !== blockHash || BigInt(block.number) !== BigInt(blockNumber))
		throw new Error("Storage checkpoint chain or canonical block changed");
	if (!code || code === "0x" || getAddress(proof.address) !== address) throw new Error("Storage source is not the expected contract");
	return buildStorageSnapshot(
		{ chainId, address, blockNumber, blockHash, stateRoot: block.stateRoot, codeHash: keccak256(code), storageRoot: proof.storageHash },
		entries,
		proof.accountProof,
	);
}

export const storageImportLeaf = (index, slot, value) => keccak256(keccak256(abi.encode(["uint256", "bytes32", "bytes32"], [index, slot, value])));
const pair = (a, b) => keccak256(concat(a < b ? [a, b] : [b, a]));

/** Builds OpenZeppelin-compatible sorted-pair proofs only after rechecking the complete snapshot. */
export async function buildStorageImport(snapshot) {
	if (snapshot.schemaVersion !== 1) throw new Error("Unsupported storage snapshot version");
	const checked = await buildStorageSnapshot(snapshot.source, snapshot.entries, snapshot.accountProof);
	if (!checked.entries.length) throw new Error("An empty source has no state to migrate");
	const items = checked.entries.map((entry, index) => ({ index, ...entry, proof: [] }));
	const levels = [items.map(item => storageImportLeaf(item.index, item.slot, item.value))];
	while (levels.at(-1).length > 1) {
		const prior = levels.at(-1),
			next = [];
		for (let i = 0; i < prior.length; i += 2) next.push(i + 1 < prior.length ? pair(prior[i], prior[i + 1]) : prior[i]);
		levels.push(next);
	}
	for (const item of items) {
		let index = item.index;
		for (const level of levels.slice(0, -1)) {
			const sibling = index ^ 1;
			if (sibling < level.length) item.proof.push(level[sibling]);
			index = Math.floor(index / 2);
		}
	}
	return { schemaVersion: 1, snapshotDigest: operationDigest(checked), source: checked.source, root: levels.at(-1)[0], count: items.length, items };
}
