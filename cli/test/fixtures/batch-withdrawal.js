import { batchAccountInput, runBatchAccount, batchPlanDigest } from "../../../deployment-tooling/batch-withdrawal.js";
import { coreInterface as api, tokenInterface as token, digest } from "../../../deployment-tooling/core-withdrawal.js";
import { ZeroAddress } from "ethers";
import assert from "node:assert/strict";

export function batchHarness({ classic = true, count = 4, recipientMode = "self" } = {}) {
	const addresses = Array.from({ length: count }, (_, index) => "0x" + String(index + 1).repeat(40));
	const core = "0x" + "a".repeat(40),
		collateral = "0x" + "b".repeat(40),
		facet = "0x" + "c".repeat(40),
		recipient = "0x" + "9".repeat(40);
	const input = {
		schema: 1,
		network: "localhost",
		chainId: 31337,
		core,
		accounts: addresses,
		recipientMode,
		...(recipientMode === "common" ? { recipient } : {}),
		amount: "all",
		route: "auto",
		muonUrl: "https://muon.example/",
	};
	const report = { schema: 1, inputDigest: digest(input), rows: {} };
	const states = new Map(
		addresses.map(account => [account, { free: 0n, allocated: 0n, last: 0, nonce: 0, requests: new Map(), blockDeallocate: false }]),
	);
	let time = 1000,
		height = 100,
		sends = 0,
		fetches = 0,
		failWait = false,
		unknown = false,
		badTransfer = false;
	const txs = new Map(),
		receipts = new Map(),
		saved = [];
	const block = number => ({ number, timestamp: time, hash: "0x" + number.toString(16).padStart(64, "0") });
	const log = (name, args, iface = api, address = core) => ({ address, ...iface.encodeEventLog(iface.getEvent(name), args) });
	const request = (account, amount, { ready = false, receiver, status = 0 } = {}) => {
		const state = states.get(account),
			id = state.requests.size + 1;
		const part = [0, amount, 31337, receiver || (recipientMode === "self" ? account : recipient), ZeroAddress, ZeroAddress];
		const value = {
			id,
			user: account,
			parts: [part],
			timestamp: time,
			cooldownEndTime: ready ? time : time + 100,
			status,
			speedUp: false,
			isCooldownModified: false,
			provider: ZeroAddress,
			isPureVirtual: false,
			providerData: "0x",
			totalAmount: amount,
			totalVirtualAmount: 0,
			advancedAmount: 0,
		};
		state.requests.set(id, value);
		return value;
	};
	const provider = {
		getNetwork: async () => ({ chainId: 31337n }),
		getBlock: async tag => block(tag === "latest" ? height : Number(tag)),
		getBlockNumber: async () => height,
		getCode: async address => (states.has(address.toLowerCase()) ? "0x" : "0x60016000"),
		getTransactionCount: async account => states.get(account.toLowerCase()).nonce,
		getTransaction: async hash => txs.get(hash),
		getTransactionReceipt: async hash => receipts.get(hash),
		call: async call => {
			const iface = call.to.toLowerCase() === collateral ? token : api,
				tx = iface.parseTransaction(call),
				name = tx.name,
				args = tx.args.toArray();
			const state = states.get((call.from || args[0] || "").toString().toLowerCase());
			if (["deallocate", "withdrawTo", "initiateWithdraw", "finalizeWithdrawRequest"].includes(name)) {
				assert(state, "simulate from the real account");
				if (name === "deallocate" && state.blockDeallocate) throw new Error("locked collateral cannot be deallocated");
				if (name === "withdrawTo" && args[1] > 0n) assert(time >= state.last + 100);
				if (name === "finalizeWithdrawRequest") {
					const r = state.requests.get(Number(args[1]));
					assert.equal(r.status, 0);
					assert(time >= r.cooldownEndTime);
				}
				return name === "initiateWithdraw"
					? api.encodeFunctionResult(name, [state.requests.size + 1, Math.max(time, state.last + 100)])
					: "0x";
			}
			assert.notEqual(call.blockTag, undefined, `unpinned ${name}`);
			if (name === "facetAddress") {
				const fn = api.getFunction(args[0]).name;
				const absent =
					fn === "getMuonFunctionUpnlValidTime" ||
					(!classic &&
						[
							"initiateWithdraw",
							"finalizeWithdrawRequest",
							"getWithdrawRequests",
							"getLastWithdrawRequestId",
							"getWithdrawRequestsBatch",
						].includes(fn));
				return api.encodeFunctionResult(name, [absent ? ZeroAddress : facet]);
			}
			const values = {
				getCollateral: [collateral],
				balanceOf: [state?.free || 0n],
				balanceInfoOfPartyA: [state?.allocated || 0n, ...Array(8).fill(0n)],
				nonceOfPartyA: [3],
				getMuonConfig: [60, 60],
				withdrawCooldownOf: [state?.last || 0],
				deallocateCooldown: [100],
				isSuspended: [false],
				isPartyB: [false],
				isLegacyDeallocateDeprecated: [false],
				decimals: [6],
				getLastWithdrawRequestId: [state?.requests.size || 0],
				getWithdrawRequests: [state?.requests.get(Number(args[1]))],
				getWithdrawRequestsBatch: [
					[...(state?.requests.values() || [])].filter(
						r => r.id >= Number(args[1] || 0) && r.id < Number(args[1] || 0) + Number(args[2] || 0),
					),
				],
			};
			assert(values[name], name);
			return iface.encodeFunctionResult(name, values[name]);
		},
	};
	const getSigner = account => ({
		getAddress: async () => account,
		sendTransaction: async call => {
			const state = states.get(account),
				tx = api.parseTransaction(call),
				name = tx.name,
				args = tx.args;
			if (unknown) throw new Error("connection lost after signing");
			assert.equal(call.nonce, state.nonce);
			sends++;
			height++;
			state.nonce++;
			let logs = [];
			if (name === "deallocate") {
				state.allocated -= args[0];
				state.free += args[0];
				state.last = time;
				logs = [log("DeallocatePartyA", [account, args[0], state.allocated])];
			}
			if (name === "initiateWithdraw") {
				state.free -= args[0][0].amount * 10n ** 12n;
				const r = request(account, args[0][0].amount, { ready: time >= state.last + 100, receiver: args[0][0].receiver });
				logs = [log("WithdrawInitiated", [r.id, account, args[0], false, "0x", r.cooldownEndTime])];
			}
			if (["withdrawTo", "finalizeWithdrawRequest"].includes(name)) {
				const r = name === "finalizeWithdrawRequest" ? state.requests.get(Number(args[1])) : null;
				const amount = r ? BigInt(r.totalAmount) : args[1],
					receiver = r ? (Array.isArray(r.parts[0]) ? r.parts[0][3] : r.parts[0].receiver) : args[0];
				if (r) r.status = 3;
				else state.free -= amount * 10n ** 12n;
				logs = [
					log("Withdraw", [account, r ? account : receiver, amount]),
					log("Transfer", [core, receiver, badTransfer ? amount - 1n : amount], token, collateral),
				];
				if (r) logs.push(log("WithdrawFinalized", [r.id, account]));
			}
			const hash = "0x" + sends.toString(16).padStart(64, "0"),
				receipt = { hash, status: 1, blockNumber: height, blockHash: block(height).hash, logs, gasUsed: 1n, gasPrice: 1n };
			receipts.set(hash, receipt);
			const response = {
				...call,
				from: account,
				provider,
				hash,
				chainId: 31337n,
				wait: async () => {
					if (failWait) throw new Error("receipt timed out");
					return receipt;
				},
			};
			txs.set(hash, response);
			return response;
		},
	});
	const fetchImpl = async url => {
		fetches++;
		const query = new URL(url).searchParams,
			account = query.get("params[partyA]");
		return {
			ok: true,
			json: async () => ({
				success: true,
				result: {
					confirmed: true,
					app: "symmio",
					method: "uPnl_A",
					reqId: "0x1234",
					data: {
						timestamp: time,
						result: { chainId: "31337", symmio: core, partyA: account, nonce: "3", uPnl: "0" },
						init: { nonceAddress: account },
					},
					shieldSignature: "0x" + "01".repeat(65),
					signatures: [{ signature: "0x" + "02".repeat(32), owner: account }],
				},
			}),
		};
	};
	const run = (account, phase, execute = false, extra = {}) =>
		runBatchAccount({
			provider,
			input,
			report,
			account,
			phase,
			execute,
			signer: getSigner(account),
			save: () => saved.push(structuredClone(report)),
			fetchImpl,
			completeRequest: async (_, call) => call,
			send: async promise => (await promise).wait(),
			...extra,
		});
	return {
		input,
		report,
		states,
		addresses,
		request,
		provider,
		saved,
		run,
		stats: () => ({ sends, fetches }),
		approve: () => {
			report.approvedDigest = batchPlanDigest(report);
		},
		advance: () => {
			time += 101;
			height++;
		},
		timeout: value => {
			failWait = value;
		},
		unknown: value => {
			unknown = value;
		},
		badTransfer: () => {
			badTransfer = true;
		},
		row: account => report.rows[account.toLowerCase()],
		accountInput: account => batchAccountInput(input, account),
	};
}
