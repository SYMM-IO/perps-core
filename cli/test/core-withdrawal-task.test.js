import { buildWithdrawalPlan, digest } from "../../deployment-tooling/core-withdrawal.js";
import { createCoreWithdrawalTasks, withdrawalEnvironment, WITHDRAWAL_STEPS } from "../tasks/core-withdrawal.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const account = "0x1111111111111111111111111111111111111111",
	core = "0x2222222222222222222222222222222222222222";
const input = {
	schema: 1,
	network: "localhost",
	chainId: 31337,
	core,
	account,
	recipient: account,
	amount: "all",
	action: "all",
	route: "legacy",
	muonUrl: "https://muon.example/",
};
const snapshot = {
	timestamp: 1000,
	free: "0",
	allocated: "1000000000000000000",
	decimals: 18,
	collateral: core,
	accountCode: "0x",
	hasDeallocate: true,
	hasLegacy: true,
	hasClassic: false,
	cooldown: 100,
	withdrawableAt: 1100,
	bindings: {},
};
test("registered tasks have distinct read-only and transaction policies and account-bound signer", () => {
	const read = TASK_DEFINITIONS.find(t => t.id === "maintenance.core-withdrawal-check"),
		write = TASK_DEFINITIONS.find(t => t.id === "maintenance.core-withdrawal");
	assert.equal(read.risk, "read-only");
	assert.equal(write.transactionJournal, true);
	assert.equal(write.resumePolicy.sourceDrift, "refuse");
	assert.equal(write.signerPolicy(input).expectedAddress, account);
	assert.equal(write.signerPolicy(input).allowedModes[0], "local-node");
	assert.deepEqual(
		write.plan().map(s => s.id),
		WITHDRAWAL_STEPS.map(s => s.id),
	);
});
test("inspection environment cannot inherit execution opt-ins", () => {
	const env = withdrawalEnvironment(input);
	assert.equal(env.EXECUTE, "false");
	assert.equal(env.CONFIRM_CHAIN_ID, "");
	assert.equal(env.SYMMIO_RECIPE_READ_ONLY, "true");
	assert.equal(env.SYMMIO_SIGNER_MODE, "");
	assert.equal(withdrawalEnvironment(input, true).CONFIRM_CHAIN_ID, "31337");
});
test("cooldown leaves the ready step incomplete and resume skips deallocation", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-withdraw-task-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const eventPath = path.join(root, "events.ndjson"),
		directory = path.join(root, "core-withdrawal");
	fs.mkdirSync(directory);
	const report = {
		schema: 1,
		inputDigest: digest(input),
		plan: buildWithdrawalPlan(input, snapshot),
		operations: {},
		snapshot,
		readiness: { ready: false, readyAt: 1100 },
	};
	fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
	const task = createCoreWithdrawalTasks(x => x)[1],
		completed = new Set(),
		phases = [];
	const ctx = {
		state: { eventPath, transactions: [] },
		emit() {},
		ui: { note() {}, text: async q => q.message.match(/Type (.+) to authorize/)[1] },
		wait: m => {
			throw new Error(m);
		},
		step: async (id, title, fn) => {
			if (completed.has(id)) return;
			await fn();
			completed.add(id);
		},
		runProcess: async (cmd, args, opts) => {
			const phase = args[args.indexOf("--phase") + 1];
			phases.push(phase);
			const r = JSON.parse(fs.readFileSync(path.join(directory, "report.json")));
			if (phase === "deallocate") {
				assert.equal(opts.env.EXECUTE, "true");
				r.operations.deallocate = { status: "confirmed", hash: "0x" + "aa".repeat(32), nonce: 1, intent: {}, blockNumber: 10 };
			}
			if (phase === "ready") r.readiness = report.readiness;
			fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(r));
		},
	};
	const selected = { ...input, signer: { mode: "local-node", address: account } };
	await assert.rejects(task.run(ctx, selected), /cooldown ends/);
	assert(!completed.has("ready"));
	assert(completed.has("deallocate"));
	report.readiness.ready = true;
	await task.run(ctx, selected);
	assert.equal(phases.filter(p => p === "deallocate").length, 1);
	assert(completed.has("verify"));
});
