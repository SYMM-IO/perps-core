import { waitForCanonicalReceipt } from "../../deployment-tooling/transaction-receipt.js";
import assert from "node:assert/strict";
import test from "node:test";

const hash = `0x${"ab".repeat(32)}`,
	blockHash = `0x${"cd".repeat(32)}`;
function fixture() {
	const receipt = { hash, status: 1, blockNumber: 100, blockHash };
	const provider = { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: blockHash }), getBlockNumber: async () => 100 };
	return { receipt, provider, hash, receiptAttempts: 3, receiptIntervalMs: 0 };
}
test("receipt lifecycle honors confirmation depth using a fresh chain head", async () => {
	const f = fixture(),
		observations = [];
	let head = 99;
	f.provider.getBlockNumber = async () => ++head;
	assert.equal(await waitForCanonicalReceipt({ ...f, confirmations: 3, onObservation: x => observations.push(x) }), f.receipt);
	assert.deepEqual(
		observations.map(x => x.confirmations),
		[1, 2, 3],
	);
});
test("receipt lifecycle rejects unavailable providers and a receipt for the wrong hash", async () => {
	await assert.rejects(waitForCanonicalReceipt({ hash, provider: {} }), /requires a provider/);
	const f = fixture();
	f.receipt.hash = `0x${"ef".repeat(32)}`;
	await assert.rejects(waitForCanonicalReceipt(f), /does not match/);
});
test("receipt lifecycle fails closed on a persistent mismatch and exposes structured diagnostics", async () => {
	const f = fixture();
	f.provider.getBlock = async () => null;
	await assert.rejects(waitForCanonicalReceipt(f), e => {
		assert.equal(e.code, "CANONICAL_RECEIPT_TIMEOUT");
		assert.equal(e.observation.canonicalBlockHash, null);
		assert.equal(e.observation.receiptBlockHash, blockHash);
		return true;
	});
});

test("receipt lifecycle deadline also bounds a non-responsive RPC", async () => {
	const f = fixture();
	f.provider.getTransactionReceipt = async () => new Promise(() => {});
	await assert.rejects(waitForCanonicalReceipt({ ...f, receiptTimeoutMs: 10 }), e => {
		assert.equal(e.code, "CANONICAL_RECEIPT_TIMEOUT");
		assert.equal(e.observation.receiptBlockHash, null);
		return true;
	});
});
