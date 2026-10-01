import assert from "node:assert/strict"
import test from "node:test"

import { retryLfReads } from "./lfReadRetry.js"

const retry = { maxAttempts: 3, delayMs: 0 }

test("missing block reads retry the same block and eventually return it", async () => {
	const calls: number[] = []
	const provider = retryLfReads(
		{
			async getBlock(tag: number) {
				calls.push(tag)
				return calls.length < 3 ? null : { number: tag, hash: "0x1234" }
			},
		},
		retry,
	)
	assert.deepEqual(await provider.getBlock(123), { number: 123, hash: "0x1234" })
	assert.deepEqual(calls, [123, 123, 123])
})

test("persistent missing blocks exhaust a bounded number of reads", async () => {
	let calls = 0
	const provider = retryLfReads(
		{
			async getBlock() {
				calls++
				return null
			},
		},
		retry,
	)
	await assert.rejects(provider.getBlock(123), /verification block 123 is unavailable after 3 reads/)
	assert.equal(calls, 3)
})

test("unavailable state retries preserve the pinned block and exact call arguments", async () => {
	for (const method of ["call", "getCode"]) {
		const calls: any[][] = []
		const args = method === "call" ? [{ to: "0x1234", data: "0xabcd", blockTag: 123 }] : ["0x1234", 123]
		const provider = retryLfReads(
			{
				async [method](...received: any[]) {
					calls.push(received)
					if (calls.length < 3)
						throw Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", info: { error: { message: "header not found" } } })
					return "0x1234"
				},
			},
			retry,
		)
		assert.equal(await provider[method](...args), "0x1234")
		assert.deepEqual(calls, [args, args, args])
	}
})

test("real reverts and unrelated RPC failures stop without retries", async () => {
	for (const error of [
		Object.assign(new Error("header not found"), { code: "CALL_EXCEPTION", reason: "header not found", data: "0x1234" }),
		new Error("execution reverted: unknown block"),
		new Error("invalid API key"),
		new Error("missing revert data"),
	]) {
		let calls = 0
		const provider = retryLfReads(
			{
				async call() {
					calls++
					throw error
				},
			},
			retry,
		)
		await assert.rejects(provider.call({ blockTag: 123 }), caught => caught === error)
		assert.equal(calls, 1)
	}
})

test("transaction submission methods are never retried", async () => {
	for (const method of ["sendTransaction", "broadcastTransaction", "send"]) {
		let calls = 0
		const error = new Error("header not found")
		const provider = retryLfReads(
			{
				async [method]() {
					calls++
					throw error
				},
			},
			retry,
		)
		await assert.rejects(provider[method]("0x1234"), caught => caught === error)
		assert.equal(calls, 1)
	}
})
