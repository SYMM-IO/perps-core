import { expect } from "chai"

import { type DeploymentTransactionRecord, reconcileDeploymentTransactions } from "../../tasks/deploy/tx.js"

const ORIGINAL_HASH = `0x${"11".repeat(32)}`
const REPLACEMENT_HASH = `0x${"22".repeat(32)}`
const FROM = "0x0000000000000000000000000000000000000001"
const TO = "0x0000000000000000000000000000000000000002"

function record(): DeploymentTransactionRecord {
	return {
		label: "addTemplate(InstantOpen)",
		hash: ORIGINAL_HASH,
		nonce: 7,
		status: "timed_out",
		from: FROM,
		to: TO,
		data: "0x1234",
		value: "0",
		submittedAt: new Date(Date.now() - 60_000).toISOString(),
		durationMs: 30_000,
		confirmations: 1,
		error: "timed out",
	}
}

function receipt(hash: string, status = 1) {
	return { hash, status, blockNumber: 100, gasUsed: 21_000n, gasPrice: 2n }
}

describe("deployment transaction reconciliation", function () {
	it("recovers a timed-out transaction only after its receipt is confirmed", async function () {
		const item = record()
		const provider = {
			getBlockNumber: async () => 100,
			getTransactionReceipt: async (hash: string) => (hash === ORIGINAL_HASH ? receipt(hash) : null),
			getTransaction: async () => null,
			getTransactionCount: async () => 7,
		}

		expect(await reconcileDeploymentTransactions([item], provider, FROM, {})).to.equal(1)
		expect(item).to.include({ status: "confirmed", blockNumber: 100, gasUsed: "21000", nativeCostWei: "42000" })
		expect(item.error).to.equal(undefined)
	})

	it("blocks resume while a broadcast has no receipt or explicit reconciliation", async function () {
		const item = record()
		const provider = {
			getBlockNumber: async () => 100,
			getTransactionReceipt: async () => null,
			getTransaction: async () => null,
			getTransactionCount: async () => 7,
		}

		let failure: unknown
		try {
			await reconcileDeploymentTransactions([item], provider, FROM, {})
		} catch (error) {
			failure = error
		}
		expect(failure).to.be.instanceOf(Error)
		expect((failure as Error).message).to.include("resume is blocked")
		expect(item.status).to.equal("timed_out")
	})

	it("distinguishes a same-intent replacement from a cancellation", async function () {
		for (const sameIntent of [true, false]) {
			const item = record()
			const provider = {
				getBlockNumber: async () => 101,
				getTransactionReceipt: async (hash: string) => (hash === REPLACEMENT_HASH ? receipt(hash) : null),
				getTransaction: async (hash: string) =>
					hash === REPLACEMENT_HASH ? { from: FROM, to: sameIntent ? TO : FROM, data: sameIntent ? "0x1234" : "0x", value: 0n, nonce: 7 } : null,
				getTransactionCount: async () => 8,
			}

			expect(
				await reconcileDeploymentTransactions([item], provider, FROM, {
					DEPLOY_TX_REPLACEMENTS: `${ORIGINAL_HASH}=${REPLACEMENT_HASH}`,
				}),
			).to.equal(1)
			expect(item.status).to.equal(sameIntent ? "replaced" : "failed")
			expect(item.replacementHash).to.equal(REPLACEMENT_HASH)
		}
	})
})
