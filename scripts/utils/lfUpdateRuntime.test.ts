import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { reconcileLfReport } from "./lfUpdateRuntime.js"

test("LF recovery ignores confirmed history and emits only recovered transaction events", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lf-reconcile-"))
	const file = path.join(directory, "report.json"),
		events = path.join(directory, "events.ndjson"),
		fd = fs.openSync(events, "w"),
		previousFd = process.env.SYMMIO_TASK_EVENT_FD,
		authority = "0x1111111111111111111111111111111111111111",
		confirmedHash = "0x" + "11".repeat(32),
		unresolvedHash = "0x" + "22".repeat(32)
	process.env.SYMMIO_TASK_EVENT_FD = String(fd)
	try {
		const report = {
			apiVersion: "operations.symm.io/lf-report-v1",
			planDigest: "reviewed",
			authority,
			status: "ready",
			transactions: [
				{ hash: confirmedHash, status: "confirmed", nonce: 0, label: "already verified", confirmations: 1, submittedAt: new Date().toISOString() },
			],
		}
		fs.writeFileSync(file, JSON.stringify(report))
		const before = fs.readFileSync(file, "utf8")
		const unexpectedRpc = new Proxy(
			{},
			{
				get: () => {
					throw new Error("Confirmed history must not query RPC")
				},
			},
		)
		await reconcileLfReport(unexpectedRpc, file, "reviewed", authority)
		assert.equal(fs.readFileSync(events, "utf8"), "")
		assert.equal(fs.readFileSync(file, "utf8"), before)

		report.transactions.push({ ...report.transactions[0], hash: unresolvedHash, nonce: 1, status: "unresolved" })
		fs.writeFileSync(file, JSON.stringify(report))
		const receiptReads: string[] = []
		const provider = {
			getBlockNumber: async () => 100,
			getTransactionReceipt: async (hash: string) => {
				receiptReads.push(hash)
				return { hash, status: 1, blockNumber: 100, gasUsed: 21_000n, gasPrice: 2n }
			},
		}
		const recovered = await reconcileLfReport(provider, file, "reviewed", authority)
		assert.deepEqual(receiptReads, [unresolvedHash])
		assert.equal(recovered.transactions[1].status, "confirmed")
		const emitted = fs
			.readFileSync(events, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line))
		assert.deepEqual(
			emitted.map(event => event.detail.transaction.hash),
			[unresolvedHash],
		)
	} finally {
		if (previousFd === undefined) delete process.env.SYMMIO_TASK_EVENT_FD
		else process.env.SYMMIO_TASK_EVENT_FD = previousFd
		fs.closeSync(fd)
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
