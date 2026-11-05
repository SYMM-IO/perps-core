import { MULTICALL3, batchedProvider } from "../server/sources/multicall.js";
import { Interface } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const multicall = new Interface([
	"function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
const target = n => `0x${n.toString(16).padStart(40, "0")}`;
const word = n => `0x${n.toString(16).padStart(64, "0")}`;
/** A chain where reading `data` from a contract returns `data` back, and data ending in "ff" reverts. */
function chain({ hasMulticall = true, bundleFails = false } = {}) {
	const requests = [];
	const answer = data => {
		if (data.endsWith("ff")) throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
		return data;
	};
	return {
		requests,
		async getCode(address) {
			return address === MULTICALL3 && hasMulticall ? "0x6080" : "0x";
		},
		async call(tx) {
			requests.push(tx);
			if (tx.to !== MULTICALL3) return answer(tx.data);
			if (bundleFails) throw new Error("out of gas");
			const [calls] = multicall.decodeFunctionData("aggregate3", tx.data);
			return multicall.encodeFunctionResult("aggregate3", [
				calls.map(c => {
					try {
						return { success: true, returnData: answer(c.callData) };
					} catch {
						return { success: false, returnData: "0x08c379a0" };
					}
				}),
			]);
		},
		async getBlockNumber() {
			return 7;
		},
	};
}

test("reads asked for together travel in one request at one block, each with its own answer or revert", async () => {
	const rpc = chain();
	const provider = batchedProvider(rpc);
	const results = await Promise.allSettled([
		provider.call({ to: target(1), data: word(1), blockTag: 500 }),
		provider.call({ to: target(2), data: word(2), blockTag: 500 }),
		provider.call({ to: target(3), data: word(0xff), blockTag: 500 }),
		provider.call({ to: target(4), data: word(4), blockTag: 500 }),
	]);
	assert.deepEqual(
		results.map(r => r.status),
		["fulfilled", "fulfilled", "rejected", "fulfilled"],
	);
	assert.deepEqual([results[0].value, results[1].value, results[3].value], [word(1), word(2), word(4)]);
	assert.equal(results[2].reason.code, "CALL_EXCEPTION");
	assert.equal(results[2].reason.data, "0x08c379a0");
	assert.equal(results[2].reason.transaction.to, target(3));
	assert.equal(rpc.requests.length, 1);
	assert.deepEqual([rpc.requests[0].to, rpc.requests[0].blockTag], [MULTICALL3, 500]);
	assert.deepEqual(provider.readStats, { reads: 4, requests: 1, bundles: 1, largest: 4 });
	// The rest of the provider is untouched.
	assert.equal(await provider.getBlockNumber(), 7);
});

test("a large round is split into full bundles, and different blocks never share one", async () => {
	const rpc = chain();
	const provider = batchedProvider(rpc, { maxCalls: 50 });
	const values = await Promise.all([
		...Array.from({ length: 120 }, (_, i) => provider.call({ to: target(i + 1), data: word(i), blockTag: 500 })),
		provider.call({ to: target(1), data: word(900), blockTag: 501 }),
		provider.call({ to: target(2), data: word(901), blockTag: 501 }),
	]);
	assert.deepEqual(values.slice(0, 3), [word(0), word(1), word(2)]);
	assert.equal(values[121], word(901));
	const sizes = rpc.requests.map(r => [r.blockTag, multicall.decodeFunctionData("aggregate3", r.data)[0].length]);
	assert.deepEqual(
		sizes.sort((a, b) => a[0] - b[0] || b[1] - a[1]),
		[
			[500, 50],
			[500, 50],
			[500, 20],
			[501, 2],
		],
	);
});

test("a lone read, a read with a sender, and a chain without Multicall3 all go out exactly as before", async () => {
	const rpc = chain();
	const provider = batchedProvider(rpc);
	assert.equal(await provider.call({ to: target(1), data: word(1), blockTag: 9 }), word(1));
	assert.deepEqual(rpc.requests, [{ to: target(1), data: word(1), blockTag: 9 }]);
	const withSender = { to: target(2), data: word(2), from: target(99) };
	await Promise.all([provider.call(withSender), provider.call({ ...withSender, data: word(3) })]);
	assert.deepEqual(
		rpc.requests.slice(1).map(r => r.to),
		[target(2), target(2)],
	);

	const bare = chain({ hasMulticall: false });
	const plain = batchedProvider(bare);
	const settled = await Promise.allSettled([
		plain.call({ to: target(1), data: word(1), blockTag: 3 }),
		plain.call({ to: target(2), data: word(0xff), blockTag: 3 }),
		plain.call({ to: target(3), data: word(3), blockTag: 3 }),
	]);
	assert.deepEqual(
		settled.map(r => r.status),
		["fulfilled", "rejected", "fulfilled"],
	);
	assert.ok(bare.requests.every(r => r.to !== MULTICALL3));
	assert.equal(bare.requests.length, 3);
});

test("a bundle the node refuses is retried read by read, so no answer is lost", async () => {
	const rpc = chain({ bundleFails: true });
	const provider = batchedProvider(rpc);
	const values = await Promise.all([provider.call({ to: target(1), data: word(1) }), provider.call({ to: target(2), data: word(2) })]);
	assert.deepEqual(values, [word(1), word(2)]);
	assert.deepEqual(
		rpc.requests.map(r => r.to),
		[MULTICALL3, target(1), target(2)],
	);
	assert.equal(provider.readStats.bundles, 0);
});
