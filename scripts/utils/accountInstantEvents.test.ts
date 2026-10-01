import assert from "node:assert/strict"
import test from "node:test"

import { discoverEvents } from "../../tasks/deploy/accountInstantSnapshot.js"

const address = "0x386EF97D913acf02B3C9452da4Cd4aaEc82eFBca"
const transaction = `0x${"1".repeat(64)}`
const blockHash = `0x${"2".repeat(64)}`
const topic = `0x${"3".repeat(64)}`
const start = 501463782
function fixture() {
	const calls: any[] = []
	const receipt: any = { hash: transaction, status: 1, to: null, contractAddress: address, blockNumber: start, blockHash }
	const events = [
		{ blockNumber: start, index: 0 }, // Constructor/initializer role grant must be included.
		{ blockNumber: start + 499, index: 1 },
		{ blockNumber: start + 500, index: 0 }, // An adjacent range may contain a revocation.
		{ blockNumber: start + 1000, index: 0 },
	]
	const provider: any = {
		getTransactionReceipt: async () => receipt,
		getBlock: async () => ({ hash: blockHash }),
		getLogs: async (filter: any) => {
			calls.push(filter)
			if (filter.toBlock - filter.fromBlock + 1 > 500)
				throw { code: "UNKNOWN_ERROR", error: { code: -32600, message: "eth_getLogs is limited to a 500 block range" } }
			return events.filter(e => e.blockNumber >= filter.fromBlock && e.blockNumber <= filter.toBlock).reverse()
		},
	}
	return { calls, receipt, events, provider }
}

test("configuration discovery starts at the proven creation receipt and covers inclusive ranges below provider limits", async () => {
	const { provider, calls, events } = fixture()
	assert.deepEqual(await discoverEvents(provider, address, [topic], start + 1000, transaction), events)
	assert.ok(calls.every(call => call.fromBlock >= start && call.toBlock <= start + 1000))
	assert.ok(calls.every(call => call.address === address && JSON.stringify(call.topics) === JSON.stringify([[topic]])))
	const successful = calls.filter(call => call.toBlock - call.fromBlock + 1 <= 500)
	assert.equal(successful[0].fromBlock, start)
	assert.equal(successful.at(-1).toBlock, start + 1000)
	for (let i = 1; i < successful.length; i++) assert.equal(successful[i].fromBlock, successful[i - 1].toBlock + 1)
})

test("configuration discovery keeps genesis coverage when no deployment transaction is provided", async () => {
	const { provider, calls } = fixture()
	await discoverEvents(provider, address, [topic], 900)
	assert.equal(calls[0].fromBlock, 0)
	assert.equal(calls.at(-1).toBlock, 900)
})

test("configuration discovery rejects invalid or noncanonical creation receipts before scanning", async () => {
	for (const overrides of [
		{ status: 0 },
		{ contractAddress: `0x${"0".repeat(40)}` },
		{ hash: `0x${"9".repeat(64)}` },
		{ to: address },
		{ blockNumber: start + 2 },
		{ blockHash: `0x${"9".repeat(64)}` },
	]) {
		const { provider, receipt, calls } = fixture()
		Object.assign(receipt, overrides)
		await assert.rejects(discoverEvents(provider, address, [topic], start + 1, transaction), /creation receipt/)
		assert.equal(calls.length, 0)
	}
	const { provider, calls } = fixture()
	provider.getTransactionReceipt = async () => null
	await assert.rejects(discoverEvents(provider, address, [topic], start, transaction), /creation receipt/)
	assert.equal(calls.length, 0)
})

test("configuration discovery never returns partial history and redacts RPC error details", async () => {
	const { provider } = fixture()
	const calls: any[] = []
	provider.getLogs = async (filter: any) => {
		calls.push(filter)
		if (calls.length === 1) return [{ blockNumber: start, index: 0 }]
		throw { code: "SERVER_ERROR", error: { code: 429, message: "rate limit from https://secret:password@rpc.test/API_TOKEN" } }
	}
	await assert.rejects(discoverEvents(provider, address, [topic], start + 50000, transaction), error => {
		assert.match(String(error), /eth_getLogs.*501513782.*rate.limit/i)
		assert.doesNotMatch(String(error), /secret|password|API_TOKEN|rpc\.test/)
		return true
	})
	assert.equal(calls.length, 2)
})

test("authentication, pruned history and unknown RPC errors fail once with a useful safe category", async () => {
	for (const [error, pattern] of [
		[{ code: "SERVER_ERROR", info: { responseStatus: "403 Forbidden", error: { message: "forbidden secret endpoint" } } }, /access denied/i],
		[{ code: "UNKNOWN_ERROR", error: { code: -32000, message: "historical state unavailable: missing trie node" } }, /historical data unavailable/i],
		[{ code: "NETWORK_ERROR", message: "secret endpoint" }, /NETWORK_ERROR/],
	] as const) {
		const { provider } = fixture()
		let calls = 0
		provider.getLogs = async () => {
			calls++
			throw error
		}
		await assert.rejects(discoverEvents(provider, address, [topic], start + 1000, transaction), pattern)
		assert.equal(calls, 1)
	}
})

test("range limits can shrink to one block and still fail closed when that block cannot be read", async () => {
	const { provider } = fixture()
	let calls = 0
	provider.getLogs = async () => {
		calls++
		throw { code: -32005, message: "too many results" }
	}
	await assert.rejects(discoverEvents(provider, address, [topic], start + 3, transaction), /blocks 501463782-501463782/)
	assert.equal(calls, 3)
})
