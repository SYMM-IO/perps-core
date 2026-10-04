import { submitOperation } from "../../deployment-tooling/operation-transaction.js";
import assert from "node:assert/strict";
import test from "node:test";

const hash = byte => `0x${byte.repeat(64)}`;
function fixture() {
	const from = `0x${"11".repeat(20)}`,
		to = `0x${"22".repeat(20)}`;
	const txHash = hash("a"),
		sealedHash = hash("b");
	const action = { phase: "deallocate", to, data: "0x1234", value: "0" };
	const tx = { from, to, data: action.data, value: 0n, nonce: 7, chainId: 8453n };
	const receipt = { hash: txHash, status: 1, blockNumber: 100, blockHash: sealedHash, logs: [] };
	const report = {},
		saved = [],
		messages = [];
	let sends = 0;
	const provider = {
		getTransactionCount: async () => 7,
		getTransaction: async () => tx,
		getTransactionReceipt: async () => receipt,
		getBlock: async () => ({ hash: sealedHash }),
	};
	const args = {
		provider,
		action,
		report,
		plan: { input: { operator: from, chainId: 8453 } },
		receiptAttempts: 3,
		receiptIntervalMs: 0,
		save: () => saved.push(structuredClone(report)),
		onProgress: message => messages.push(message),
		signer: {
			getAddress: async () => from,
			sendTransaction: async () => {
				sends++;
				return { hash: txHash };
			},
		},
		completeRequest: async (_provider, request) => request,
		send: async () => receipt,
	};
	return { args, tx, receipt, report, saved, messages, sends: () => sends, sealedHash, txHash };
}
for (const early of ["missing-block", "wrong-hash", "zero-hash", "missing-receipt", "missing-transaction"]) {
	test(`canonical receipt polling recovers from ${early} without resending`, async () => {
		const f = fixture();
		let reads = 0;
		f.args.provider.getTransactionReceipt = async () => {
			reads++;
			if (reads === 1 && early === "missing-receipt") return null;
			return reads === 1 && early === "zero-hash" ? { ...f.receipt, blockHash: hash("0") } : f.receipt;
		};
		f.args.provider.getTransaction = async () => (reads === 1 && early === "missing-transaction" ? null : f.tx);
		f.args.provider.getBlock = async () =>
			reads === 1 && early === "missing-block" ? null : { hash: reads === 1 && early === "wrong-hash" ? hash("c") : f.sealedHash };
		assert.equal(await submitOperation(f.args), f.receipt);
		assert.equal(f.report.operations.deallocate.status, "confirmed");
		assert.equal(f.sends(), 1);
		assert.equal(reads, 2);
		assert.match(f.messages[0], /Waiting.*canonical receipt/);
		await submitOperation({ ...f.args, signer: undefined });
		assert.equal(f.sends(), 1);
	});
}
test("polling rereads a receipt that moves to a different sealed block", async () => {
	const f = fixture();
	const finalReceipt = { ...f.receipt, blockNumber: 101, blockHash: hash("d"), logs: [{ sealed: true }] };
	let reads = 0;
	f.args.provider.getTransactionReceipt = async () => (++reads === 1 ? f.receipt : finalReceipt);
	f.args.provider.getBlock = async n => ({ hash: n === 100 ? hash("c") : hash("d") });
	assert.equal(await submitOperation(f.args), finalReceipt);
	assert.equal(f.report.operations.deallocate.blockNumber, 101);
	assert.equal(f.report.operations.deallocate.blockHash, hash("d"));
	assert.equal(f.sends(), 1);
});
test("persistent canonical mismatch saves diagnostics, stays submitted and resumes without resend", async () => {
	const f = fixture();
	f.args.provider.getBlock = async () => ({ hash: hash("c") });
	await assert.rejects(submitOperation(f.args), error => {
		assert.match(error.message, /Canonical receipt verification timed out/);
		assert(error.message.includes(f.txHash) && error.message.includes(f.sealedHash) && error.message.includes(hash("c")));
		return true;
	});
	assert.equal(f.report.operations.deallocate.status, "submitted");
	assert.equal(f.report.operations.deallocate.confirmation.attempt, 3);
	assert(f.saved.some(s => s.operations?.deallocate?.confirmation?.canonicalBlockHash === hash("c")));
	f.args.provider.getBlock = async () => ({ hash: f.sealedHash });
	await submitOperation({ ...f.args, signer: undefined });
	assert.equal(f.sends(), 1);
	assert.equal(f.report.operations.deallocate.status, "confirmed");
});
test("a reverted receipt or transaction identity change fails immediately", async () => {
	for (const mode of ["reverted", "nonce", "data", "chainId"]) {
		const f = fixture();
		let reads = 0;
		f.args.provider.getTransactionReceipt = async () => {
			reads++;
			return f.receipt;
		};
		if (mode === "reverted") f.receipt.status = 0;
		else f.tx[mode] = mode === "data" ? "0xbeef" : 999;
		await assert.rejects(submitOperation(f.args), mode === "reverted" ? /reverted/ : /intent and nonce/);
		assert.equal(reads, 1);
		assert.equal(f.report.operations.deallocate.status, "submitted");
		assert.equal(f.sends(), 1);
	}
});
test("invalid polling bounds fail before any send", async () => {
	for (const override of [{ receiptAttempts: 0 }, { receiptAttempts: 32 }, { receiptIntervalMs: -1 }, { receiptIntervalMs: 1001 }]) {
		const f = fixture();
		await assert.rejects(submitOperation({ ...f.args, ...override }), /Invalid receipt polling/);
		assert.equal(f.sends(), 0);
	}
});
test("submission guard runs after fee and nonce reads, before journaling or signing", async () => {
	const f = fixture();
	const order = [];
	f.args.completeRequest = async (_provider, request) => {
		order.push("fees");
		return request;
	};
	f.args.provider.getTransactionCount = async () => {
		order.push("nonce");
		return 7;
	};
	await assert.rejects(
		submitOperation({
			...f.args,
			beforeSubmit: async () => {
				order.push("guard");
				assert.equal(f.report.operations.deallocate, undefined);
				throw new Error("signature expired");
			},
		}),
		/signature expired/,
	);
	assert.deepEqual(order, ["fees", "nonce", "guard"]);
	assert.equal(f.sends(), 0);
	assert.equal(f.report.operations.deallocate, undefined);
	assert.equal(f.saved.length, 0);
});
test("submission guard never runs during reconciliation of an existing operation", async () => {
	const f = fixture();
	let checks = 0;
	const beforeSubmit = async () => {
		checks++;
	};
	await submitOperation({ ...f.args, beforeSubmit });
	await submitOperation({
		...f.args,
		signer: undefined,
		beforeSubmit: async () => {
			throw new Error("expired now");
		},
	});
	assert.equal(checks, 1);
	assert.equal(f.sends(), 1);
});
