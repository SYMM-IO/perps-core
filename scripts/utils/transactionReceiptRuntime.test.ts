import assert from "node:assert/strict"
import test from "node:test"

import { send, getDeploymentTransactionJournal, resetDeploymentTransactionJournal, reconcileDeploymentTransactions } from "../../tasks/deploy/tx.js"

const hash = `0x${"ab".repeat(32)}`,
	blockHash = `0x${"cd".repeat(32)}`
function fixture() {
	const receipt = { hash, status: 1, blockNumber: 100, blockHash, gasUsed: 21000n, gasPrice: 2n }
	let reads = 0
	const provider: any = {
		getTransactionReceipt: async () => {
			reads++
			return reads === 1 ? { ...receipt, blockHash: `0x${"00".repeat(32)}` } : receipt
		},
		getBlock: async () => ({ hash: blockHash }),
		getBlockNumber: async () => 100,
		getTransaction: async () => null,
		getTransactionCount: async () => 7,
	}
	const tx: any = { hash, nonce: 7, provider, wait: async () => receipt }
	return { receipt, provider, tx }
}
test("shared send confirms only after a canonical receipt and calls write-ahead once", async () => {
	resetDeploymentTransactionJournal()
	const f = fixture()
	const statuses: string[] = []
	let writes = 0
	const result = await send(Promise.resolve(f.tx), "generic operation", 1, {
		receiptPolicy: { receiptAttempts: 3, receiptIntervalMs: 0 },
		onSubmitted: record => {
			statuses.push(record.status)
			writes++
		},
	})
	assert.equal(result, f.receipt)
	assert.deepEqual(statuses, ["unresolved"])
	assert.equal(writes, 1)
	assert.equal(getDeploymentTransactionJournal()[0].status, "confirmed")
	assert.equal(getDeploymentTransactionJournal()[0].confirmation?.attempt, 2)
})
test("shared send retains timed-out hash and mismatch evidence for subsequent reconciliation", async () => {
	resetDeploymentTransactionJournal()
	const f = fixture()
	f.provider.getBlock = async () => ({ hash: `0x${"ef".repeat(32)}` })
	await assert.rejects(
		send(Promise.resolve(f.tx), "generic operation", 1, { receiptPolicy: { receiptAttempts: 2, receiptIntervalMs: 0 } }),
		/Canonical receipt verification timed out/,
	)
	const record = getDeploymentTransactionJournal()[0]
	assert.equal(record.status, "timed_out")
	assert.equal(record.hash, hash)
	assert.equal(record.confirmedAt, undefined)
	assert.equal(record.confirmation?.canonicalBlockHash, `0x${"ef".repeat(32)}`)
	f.provider.getBlock = async () => ({ hash: blockHash })
	assert.equal(await reconcileDeploymentTransactions([record], f.provider, undefined, {}, { receiptAttempts: 2, receiptIntervalMs: 0 }), 1)
	assert.equal(record.status, "confirmed")
})
test("shared send requires a canonical-capable provider and never reports success without it", async () => {
	resetDeploymentTransactionJournal()
	const f = fixture()
	f.tx.provider = undefined
	await assert.rejects(send(Promise.resolve(f.tx), "generic operation"), /requires a provider/)
	assert.equal(getDeploymentTransactionJournal()[0].status, "unresolved")
})

test("shared send preserves a known replacement through canonical timeout and recovers it without another send", async () => {
	resetDeploymentTransactionJournal()
	const f = fixture(),
		replacementHash = `0x${"ef".repeat(32)}`
	const from = `0x${"11".repeat(20)}`,
		to = `0x${"22".repeat(20)}`
	const replacement = { from, to, data: "0x1234", value: 0n, nonce: 7, hash: replacementHash }
	const receipt = { ...f.receipt, hash: replacementHash }
	Object.assign(f.tx, {
		from,
		to,
		data: "0x1234",
		value: 0n,
		wait: async () => {
			throw { code: "TRANSACTION_REPLACED", cancelled: false, receipt, replacement }
		},
	})
	f.provider.getTransactionReceipt = async (h: string) => (h === replacementHash ? receipt : null)
	f.provider.getTransaction = async (h: string) => (h === replacementHash ? replacement : null)
	f.provider.getBlock = async () => null
	await assert.rejects(
		send(Promise.resolve(f.tx), "replacement operation", 1, { receiptPolicy: { receiptAttempts: 1 } }),
		/Canonical receipt verification timed out/,
	)
	const record = getDeploymentTransactionJournal()[0]
	assert.equal(record.status, "timed_out")
	assert.equal(record.replacementHash, replacementHash)
	f.provider.getBlock = async () => ({ hash: blockHash })
	assert.equal(await reconcileDeploymentTransactions([record], f.provider, from, {}, { receiptAttempts: 1 }), 1)
	assert.equal(record.status, "replaced")
})
