import {
	buildStorageSnapshot,
	buildStorageImport,
	readStorageSnapshot,
	storageImportLeaf,
} from "../../deployment-tooling/operations/storage-snapshot.js";
import { createMPT, createMerkleProof } from "@ethereumjs/mpt";
import { encodeRlp, getBytes, hexlify, toBeHex, concat, keccak256 } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const word = value => toBeHex(value, 32);
const source = { chainId: 31337, address: toBeHex(1, 20), blockNumber: 1, blockHash: word(2), codeHash: keccak256("0x6000") };

async function fixture() {
	const entries = [
		{ slot: word(11), value: word(66) },
		{ slot: word(22), value: word(123) },
	];
	const trie = await createMPT({ useKeyHashing: true });
	for (const entry of entries) await trie.put(getBytes(entry.slot), getBytes(encodeRlp(toBeHex(BigInt(entry.value)))));
	const accountTrie = await createMPT({ useKeyHashing: true });
	const storageRoot = hexlify(trie.root());
	await accountTrie.put(getBytes(source.address), getBytes(encodeRlp(["0x01", "0x", storageRoot, source.codeHash])));
	const accountProof = (await createMerkleProof(accountTrie, getBytes(source.address))).map(hexlify);
	return { entries, accountProof, source: { ...source, stateRoot: hexlify(accountTrie.root()), storageRoot } };
}

test("storage-root verification rejects omitted, invented and duplicated mapping entries", async () => {
	const f = await fixture();
	const snapshot = await buildStorageSnapshot(f.source, f.entries, f.accountProof);
	assert.equal(snapshot.entries.length, 2);
	await assert.rejects(buildStorageSnapshot(f.source, f.entries.slice(0, 1), f.accountProof), /complete/);
	await assert.rejects(buildStorageSnapshot(f.source, [...f.entries, { slot: word(33), value: word(1) }], f.accountProof), /complete/);
	await assert.rejects(buildStorageSnapshot(f.source, [...f.entries, f.entries[0]], f.accountProof), /Duplicate/);
	await assert.rejects(buildStorageSnapshot(f.source, [...f.entries, { slot: word(33), value: word(0) }], f.accountProof), /Zero/);
});

test("import commitments are deterministic and bind source plus each raw slot value", async () => {
	const f = await fixture(),
		snapshot = await buildStorageSnapshot(f.source, f.entries, f.accountProof);
	const first = await buildStorageImport(snapshot),
		second = await buildStorageImport(await buildStorageSnapshot(f.source, [...f.entries].reverse(), f.accountProof));
	assert.deepEqual(first, second);
	assert.equal(first.items.length, snapshot.entries.length);
	assert.ok(first.items.every(item => item.proof.length > 0));
	assert.notEqual(
		first.snapshotDigest,
		(await buildStorageImport({ ...snapshot, source: { ...snapshot.source, blockHash: word(4) } })).snapshotDigest,
	);
	for (const item of first.items) {
		let hash = storageImportLeaf(item.index, item.slot, item.value);
		for (const sibling of item.proof) hash = keccak256(concat(hash < sibling ? [hash, sibling] : [sibling, hash]));
		assert.equal(hash, first.root);
	}
	await assert.rejects(buildStorageImport({ ...snapshot, entries: snapshot.entries.slice(0, 1) }), /complete/);
});

test("account proofs bind the address, storage root and runtime code to a block state root", async () => {
	const f = await fixture();
	for (const changed of [{ address: toBeHex(2, 20) }, { stateRoot: word(9) }, { storageRoot: word(9) }, { codeHash: word(9) }])
		await assert.rejects(buildStorageSnapshot({ ...f.source, ...changed }, f.entries, f.accountProof), /proof/);
});

test("RPC snapshot reader rejects reorgs, another chain and a code/proof mismatch", async () => {
	const f = await fixture();
	const replies = {
		eth_chainId: toBeHex(f.source.chainId),
		eth_getBlockByNumber: { number: toBeHex(f.source.blockNumber), hash: f.source.blockHash, stateRoot: f.source.stateRoot },
		eth_getProof: { address: f.source.address, storageHash: f.source.storageRoot, accountProof: f.accountProof },
		eth_getCode: "0x6000",
	};
	const calls = [];
	const checked = await readStorageSnapshot(
		{
			send: async (name, args) => {
				calls.push([name, args]);
				return replies[name];
			},
		},
		f.source,
		f.entries,
	);
	assert.deepEqual(checked.entries, f.entries);
	assert.ok(calls.filter(([name]) => name !== "eth_chainId").every(([, args]) => args.includes("0x01")));
	await assert.rejects(
		readStorageSnapshot({ send: async name => (name === "eth_getCode" ? "0x6001" : replies[name]) }, f.source, f.entries),
		/proof/,
	);
	await assert.rejects(
		readStorageSnapshot({ send: async name => (name === "eth_chainId" ? "0x01" : replies[name]) }, f.source, f.entries),
		/chain/,
	);
	await assert.rejects(
		readStorageSnapshot(
			{ send: async name => (name === "eth_getBlockByNumber" ? { ...replies[name], hash: word(4) } : replies[name]) },
			f.source,
			f.entries,
		),
		/block/,
	);
});
