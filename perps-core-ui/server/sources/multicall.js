import { Interface } from "ethers";

/** Multicall3 sits at this address on every chain it has been deployed to. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall = new Interface([
	"function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
// Provider methods that each cost one RPC request; counted so a slow inspection can say where its time went.
const COUNTED = new Set(["getCode", "getStorage", "getLogs", "getBlock", "getBlockNumber", "getBalance", "getTransactionCount", "getTransaction"]);
const tagKey = tag => (typeof tag === "bigint" || typeof tag === "number" ? `#${tag}` : String(tag ?? "latest"));
function reverted(call, data) {
	const error = new Error("execution reverted");
	error.code = "CALL_EXCEPTION";
	error.data = data;
	error.transaction = { to: call.to, data: call.data };
	return error;
}

/**
 * Wraps a provider so that reads asked for at the same moment travel together. One `eth_call` to
 * Multicall3 carries up to `maxCalls` of them and answers at a single block, so a scan that issues
 * thousands of `hasRole` reads costs tens of requests instead of thousands.
 *
 * Nothing about a read changes for the caller: it gets its own return data, or a revert error of
 * its own. Reads the bundle cannot carry (a sender, a value, an unknown chain) go out as before, and
 * if the chain has no Multicall3 at that block the wrapper steps aside entirely.
 */
export function batchedProvider(provider, { address = MULTICALL3, maxCalls = 96, windowMs = 4 } = {}) {
	const queues = new Map();
	const stats = { reads: 0, requests: 0, bundles: 0, largest: 0 };
	// The other requests (code, storage, logs, blocks), bundles re-sent call by call, and requests the RPC refused.
	const traffic = { other: 0, retries: 0, failed: 0 };
	let available;
	const direct = tx => {
		stats.requests++;
		return provider.call(tx);
	};
	async function supported(blockTag) {
		// Asked once: a chain either has the contract or it does not.
		if (available === undefined) traffic.other++;
		available ??= provider.getCode(address, blockTag).then(
			code => code !== "0x",
			() => false,
		);
		return available;
	}
	async function flush(key) {
		const queue = queues.get(key);
		queues.delete(key);
		if (!queue) return;
		clearTimeout(queue.timer);
		const { calls, blockTag } = queue;
		const each = () => calls.forEach(c => direct({ to: c.to, data: c.data, blockTag }).then(c.resolve, c.reject));
		if (calls.length === 1 || !(await supported(blockTag))) return each();
		let results;
		try {
			stats.requests++;
			const answer = await provider.call({
				to: address,
				data: multicall.encodeFunctionData("aggregate3", [calls.map(c => ({ target: c.to, allowFailure: true, callData: c.data }))]),
				blockTag,
			});
			results = multicall.decodeFunctionResult("aggregate3", answer)[0];
			if (results.length !== calls.length) throw new Error("Multicall answered a different number of reads");
		} catch {
			// One oversized or malformed bundle must not fail the reads inside it.
			traffic.retries++;
			return each();
		}
		stats.bundles++;
		stats.largest = Math.max(stats.largest, calls.length);
		calls.forEach((c, i) => (results[i].success ? c.resolve(results[i].returnData) : c.reject(reverted(c, results[i].returnData))));
	}
	function call(tx) {
		const extra = Object.keys(tx).filter(k => !["to", "data", "blockTag"].includes(k) && tx[k] != null);
		if (!tx.to || !tx.data || extra.length || typeof tx.to !== "string") return direct(tx);
		stats.reads++;
		const key = tagKey(tx.blockTag);
		return new Promise((resolve, reject) => {
			let queue = queues.get(key);
			if (!queue) {
				queue = { calls: [], blockTag: tx.blockTag, timer: setTimeout(() => flush(key), windowMs) };
				queues.set(key, queue);
			}
			queue.calls.push({ to: tx.to, data: tx.data, resolve, reject });
			if (queue.calls.length >= maxCalls) flush(key);
		});
	}
	// Everything but `call` is the provider's own: block lookups, code, storage, logs.
	const wrapped = new Proxy(provider, {
		get(target, property) {
			if (property === "call") return call;
			if (property === "readStats") return stats;
			if (property === "requestStats") return traffic;
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (!COUNTED.has(property)) return value.bind(target);
			return (...args) => {
				traffic.other++;
				const answer = value.apply(target, args);
				answer?.catch?.(() => traffic.failed++);
				return answer;
			};
		},
	});
	return wrapped;
}
