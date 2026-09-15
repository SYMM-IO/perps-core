import assert from "node:assert/strict"
import test from "node:test"

import { verifyLfReceiptState } from "./lfReceipt.js"

const hash = "0x" + "11".repeat(32),
	blockHash = "0x" + "22".repeat(32),
	staleHash = "0x" + "33".repeat(32)
const receipt = { hash, blockNumber: 100, blockHash, status: 1 }
const block = { number: 100, hash: blockHash, timestamp: 123, transactions: [hash] }

for (const earlyHash of ["0x" + "00".repeat(32), staleHash]) {
	test(`refreshes the affected receipt after an early ${earlyHash === staleHash ? "different" : "zero"} block hash`, async () => {
		let refreshes = 0,
			stateReads = 0
		const observations: any[] = []
		const result = await verifyLfReceiptState({
			provider: {
				getBlock: async () => block,
				getTransactionReceipt: async (requested: string) => {
					assert.equal(requested, hash)
					refreshes++
					return receipt
				},
			},
			hash,
			initialReceipt: { ...receipt, blockHash: earlyHash },
			readState: async pinned => {
				assert.equal(pinned.hash, blockHash)
				stateReads++
				return "correct state"
			},
			onReceipt: observed => observations.push(observed),
			retry: { maxAttempts: 3, delayMs: 0 },
		})
		assert.equal(refreshes, 1)
		assert.equal(stateReads, 1)
		assert.equal(result.state, "correct state")
		assert.deepEqual(
			observations.map(item => item.blockHash),
			[earlyHash, blockHash],
		)
	})
}

test("an agreeing successful receipt does not trigger another receipt lookup", async () => {
	const result = await verifyLfReceiptState({
		provider: {
			getBlock: async () => block,
			getTransactionReceipt: async () => {
				throw new Error("Must not reconcile success")
			},
		},
		hash,
		initialReceipt: receipt,
		readState: async () => "verified",
		onReceipt() {},
	})
	assert.equal(result.state, "verified")
})

test("persistent disagreement or absent block inclusion never accepts state", async () => {
	for (const observedBlock of [
		{ ...block, hash: staleHash },
		{ ...block, transactions: [] },
	]) {
		let refreshes = 0
		await assert.rejects(
			verifyLfReceiptState({
				provider: {
					getBlock: async () => observedBlock,
					getTransactionReceipt: async () => {
						refreshes++
						return receipt
					},
				},
				hash,
				initialReceipt: receipt,
				readState: async () => {
					throw new Error("Must not accept this block")
				},
				onReceipt() {},
				retry: { maxAttempts: 3, delayMs: 0 },
			}),
			/changed or remains inconsistent/,
		)
		assert.equal(refreshes, 2)
	}
})

test("a refresh for the wrong transaction or a failed receipt stops immediately", async () => {
	for (const refreshed of [
		{ ...receipt, hash: staleHash },
		{ ...receipt, status: 0 },
	]) {
		await assert.rejects(
			verifyLfReceiptState({
				provider: { getBlock: async () => block, getTransactionReceipt: async () => refreshed },
				hash,
				initialReceipt: { ...receipt, blockHash: staleHash },
				readState: async () => {
					throw new Error("Must not read state")
				},
				onReceipt() {},
				retry: { maxAttempts: 3, delayMs: 0 },
			}),
			/different transaction|no longer has a successful receipt/,
		)
	}
})

test("a block change during state reads causes a fresh receipt and a fresh state read", async () => {
	let blockReads = 0,
		stateReads = 0
	const result = await verifyLfReceiptState({
		provider: {
			getBlock: async () => (++blockReads === 1 ? block : { ...block, hash: staleHash }),
			getTransactionReceipt: async () => ({ ...receipt, blockHash: staleHash }),
		},
		hash,
		initialReceipt: receipt,
		readState: async () => ++stateReads,
		onReceipt() {},
		retry: { maxAttempts: 3, delayMs: 0 },
	})
	assert.equal(result.state, 2)
	assert.equal(result.block.hash, staleHash)
})
