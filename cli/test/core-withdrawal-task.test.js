import { buildWithdrawalPlan, digest } from "../../deployment-tooling/core-withdrawal.js";
import { createCoreWithdrawalTasks, withdrawalEnvironment, withdrawalHistory, WITHDRAWAL_STEPS } from "../tasks/core-withdrawal.js";
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

function historyFixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "withdrawal-history-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const save = (name, overrides = {}) => {
		const directory = path.join(root, "history", name);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(
			path.join(directory, "state.json"),
			JSON.stringify({
				taskId: "maintenance.core-withdrawal",
				status: "completed",
				finishedAt: "2026-10-01T12:00:00Z",
				input: { ...input, network: "bsc", chainId: 56, amount: "12.5", recipient: "0x3333333333333333333333333333333333333333" },
				...overrides,
			}),
		);
	};
	return { root, save };
}
function preparationUi(overrides = {}) {
	const prompts = [],
		notes = [];
	const answer = async q => {
		prompts.push(q);
		const value = Object.hasOwn(overrides, q.message) ? overrides[q.message] : q.initialValue;
		if (value != null && q.validate) assert.equal(q.validate(value), undefined);
		return value;
	};
	return { prompts, notes, select: answer, text: answer, note: (...args) => notes.push(args) };
}
test("history uses only valid completed executions and whitelists configuration", t => {
	const { root, save } = historyFixture(t);
	save("valid");
	save("newer", { finishedAt: "2026-10-02T12:00:00Z", input: { ...input, signer: { secret: "must-not-copy" }, approval: "old" } });
	for (const status of ["failed", "cancelled", "paused", "waiting_external"]) save(status, { status });
	save("check", { taskId: "maintenance.core-withdrawal-check" });
	save("wrong-chain", { input: { ...input, chainId: 56 } });
	save("secret-url", { input: { ...input, muonUrl: "https://user:password@muon.example/" } });
	save("invalid-time", { finishedAt: "invalid" });
	save("broken");
	fs.writeFileSync(path.join(root, "history", "broken", "state.json"), "{");
	const rows = withdrawalHistory(root);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].input.network, "localhost");
	assert.equal(rows[0].input.signer, undefined);
	assert.equal(rows[0].input.approval, undefined);
	assert.deepEqual(withdrawalHistory(path.join(root, "missing")), []);
});
test("same-chain suggestions remain editable and do not copy transaction evidence", async t => {
	const { root, save } = historyFixture(t);
	save("bsc");
	save("other-chain", { finishedAt: "2026-10-02T12:00:00Z", input });
	const ui = preparationUi({ "Core network": "bsc", "Collateral amount, or all (frozen at inspection)": "4.25" });
	const prepared = await createCoreWithdrawalTasks(x => x)[1].prepare({ stateRoot: root, ui });
	assert.equal(ui.prompts[0].initialValue, "localhost");
	const chooser = ui.prompts.find(q => q.message.startsWith("Suggestions"));
	assert.equal(chooser.options.length, 2);
	assert(chooser.options[0].label.includes("12.5"));
	assert.equal(prepared.chainId, 56);
	assert.equal(prepared.amount, "4.25");
	assert.equal(prepared.recipient, "0x3333333333333333333333333333333333333333");
	assert.equal(prepared.muonUrl, "https://muon.example/");
	assert.equal(prepared.route, "legacy");
	assert.equal(prepared.signer, undefined);
	assert.equal(prepared.approval, undefined);
});
test("changing account or Core clears dependent suggestions", async t => {
	const { root, save } = historyFixture(t);
	save("bsc");
	const another = "0x4444444444444444444444444444444444444444";
	for (const changeCore of [false, true]) {
		const ui = preparationUi({
			...(changeCore ? { "Core diamond address": another } : {}),
			"Account holding the Core balance (must be the signing wallet)": another,
		});
		const prepared = await createCoreWithdrawalTasks(x => x)[1].prepare({ stateRoot: root, ui });
		assert.equal(prepared.recipient, another);
		assert.equal(prepared.amount, "all");
		assert.equal(prepared.action, "all");
		assert.equal(prepared.route, changeCore ? "auto" : "legacy");
		assert.equal(prepared.muonUrl, changeCore ? "https://muon-oracle3.rasa.capital/" : "https://muon.example/");
	}
});
test("first run, new configuration, another chain and cancelled selection have no inherited payee", async t => {
	const { root, save } = historyFixture(t);
	save("bsc");
	const task = createCoreWithdrawalTasks(x => x)[1];
	for (const [stateRoot, extra] of [
		[path.join(root, "empty"), {}],
		[root, { "Suggestions from completed withdrawals on this chain": "new" }],
		[root, { "Core network": "localhost" }],
	]) {
		const ui = preparationUi({
			"Core network": "bsc",
			"Core diamond address": core,
			"Account holding the Core balance (must be the signing wallet)": account,
			...extra,
		});
		const prepared = await task.prepare({ stateRoot, ui });
		assert.equal(prepared.recipient, account);
		assert.equal(prepared.amount, "all");
		assert.equal(prepared.route, "auto");
	}
	assert.equal(await task.prepare({ stateRoot: root, ui: preparationUi({ "Suggestions from completed withdrawals on this chain": null }) }), null);
	const check = await createCoreWithdrawalTasks(x => x)[0].prepare({ stateRoot: root, ui: preparationUi() });
	assert.equal(check.action, "check");
	assert.equal(check.account, account);
	assert.equal(check.recipient, account);
});
