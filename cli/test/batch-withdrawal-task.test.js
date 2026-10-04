import { batchSourceDigest } from "../../deployment-tooling/batch-withdrawal.js";
import { createBatchWithdrawalTasks, prepareBatch, readBatchFile, batchHistory } from "../tasks/batch-withdrawal.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { batchHarness } from "./fixtures/batch-withdrawal.js";
import { Wallet } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function ui(answers = {}) {
	const prompts = [],
		notes = [];
	const answer = async question => {
		prompts.push(question);
		const value = Object.hasOwn(answers, question.message) ? answers[question.message] : question.initialValue;
		if (question.validate && value != null) assert.equal(question.validate(value), undefined);
		return value;
	};
	return { prompts, notes, text: answer, select: answer, password: answer, note: (...args) => notes.push(args) };
}
function context(t, h, risk = "transaction") {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "batch-withdrawal-task-"));
	t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
	const file = path.join(scratch, "batch-withdrawal", "report.json"),
		completed = new Set(),
		calls = [],
		signing = {};
	h.report.sourceDigest = batchSourceDigest(process.cwd());
	const save = () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(h.report));
	};
	const testUi = {
		note() {},
		select: async question => question.initialValue,
		text: async question =>
			question.message.startsWith("Type ") ? question.message.match(/^Type (.*?) to authorize/)[1] : question.initialValue,
		password: async () => {
			throw new Error("read-only and local-node test must never ask for a key");
		},
	};
	const ctx = {
		root: process.cwd(),
		ui: testUi,
		state: { eventPath: path.join(scratch, "events.ndjson"), risk, transactions: [] },
		checkpoint() {},
		bindSigner: (role, selection) => (signing[role] = selection),
		getSigner: role => signing[role],
		emit: (type, { transaction } = {}) => {
			if (type === "tx.submitted" && transaction) ctx.state.transactions.push(transaction);
		},
		step: async (id, title, fn) => {
			if (completed.has(id)) return;
			await fn();
			completed.add(id);
		},
		wait: message => {
			throw new Error(message);
		},
		runProcess: async (_, args, { env }) => {
			const phase = args[args.indexOf("--phase") + 1],
				account = args[args.indexOf("--account") + 1];
			calls.push({ phase, account, execute: env.EXECUTE === "true", env });
			if (fs.existsSync(file)) Object.assign(h.report, JSON.parse(fs.readFileSync(file)));
			await h.run(account, phase, env.EXECUTE === "true", {
				save,
				transaction: args.includes("--transaction") ? args[args.indexOf("--transaction") + 1] : undefined,
				transactionPhase: args.includes("--transaction-phase") ? args[args.indexOf("--transaction-phase") + 1] : undefined,
			});
		},
	};
	return { ctx, file, calls, signing, completed, save, scratch };
}
test("batch tasks are registered with per-account signers and distinct read-only recheck", () => {
	const tasks = TASK_DEFINITIONS.filter(task => task.id.startsWith("maintenance.batch-withdrawal"));
	assert.equal(tasks.length, 3);
	for (const task of tasks)
		assert.equal(
			task.inputs.some(input => input.id === "signer"),
			false,
		);
	assert.equal(tasks.find(task => task.id.endsWith("-check")).risk, "read-only");
	assert.equal(tasks.find(task => task.id.endsWith("-ready")).transactionJournal, true);
});
test("inspection failure before a report exists preserves the subprocess error and stops before authorization", async t => {
	const h = batchHarness({ count: 1 }),
		c = context(t, h),
		failure = new Error("hardhat exited with code 1: HHE50000: Invalid password or corrupted keystore file");
	c.ctx.runProcess = async () => {
		throw failure;
	};
	await assert.rejects(createBatchWithdrawalTasks(task => task)[0].run(c.ctx, h.input), error => error === failure);
	assert.equal(fs.existsSync(c.file), false);
	assert.deepEqual([...c.completed], []);
	assert.deepEqual(c.signing, {});
});
test("public-address import deduplicates accounts without asking for private keys", async t => {
	const h = batchHarness({ count: 1 });
	const testUi = ui({
		"Batch Core network": "localhost",
		"Batch Core diamond address": h.input.core,
		"Account addresses separated by commas or spaces": `${h.addresses[0]}, ${h.addresses[0]}`,
	});
	const input = await prepareBatch({ ui: testUi, stateRoot: "/tmp/nonexistent-batch-test-history" });
	assert.deepEqual(input.accounts, h.addresses);
	assert.equal(input.signer, undefined);
	assert(testUi.notes.some(note => note[0].includes("duplicate")));
});
test("masked private-key import derives addresses and stores only public batch inputs", async () => {
	const key = "0x" + "42".repeat(32);
	const testUi = ui({
		"Batch Core network": "bsc",
		"Batch Core diamond address": "0x" + "a".repeat(40),
		"Batch account list": "keys",
		"Number of private-key accounts": "1",
		"Private key": key,
	});
	const input = await prepareBatch({ ui: testUi, stateRoot: "/tmp/nonexistent-batch-test-history" });
	assert.deepEqual(input.accounts, [new Wallet(key).address]);
	assert(!JSON.stringify(input).includes(key));
	assert.equal(input.signer, undefined);
});
test("first pass continues after an account failure and stores a cooldown queue without keys for waiting-only accounts", async t => {
	const h = batchHarness(),
		[allocated, free, waiting, blocked] = h.addresses;
	h.states.get(allocated).allocated = 10n ** 19n;
	h.states.get(free).free = 10n ** 18n;
	h.request(waiting, 1_000_000n);
	h.states.get(blocked).allocated = 10n ** 18n;
	h.states.get(blocked).blockDeallocate = true;
	const c = context(t, h);
	await createBatchWithdrawalTasks(task => task)[0].run(c.ctx, h.input);
	assert.equal(h.row(allocated).status, "waiting_cooldown");
	assert.equal(h.row(free).status, "completed");
	assert.equal(h.row(blocked).status, "needs_investigation");
	assert.equal(Object.keys(c.signing).length, 3);
	assert(c.calls.filter(call => call.account === waiting).every(call => !call.execute));
	assert.equal(readBatchFile(c.file).report.rows[waiting].status, "waiting_cooldown");
	assert(!JSON.stringify(readBatchFile(c.file)).includes("privateKey"));
});
test("read-only recheck and a later ready pass do not repeat deallocation or request keys for cooling accounts", async t => {
	const h = batchHarness({ count: 2 }),
		[account, waiting] = h.addresses;
	h.states.get(account).allocated = 10n ** 18n;
	h.request(waiting, 1_000_000n);
	const first = context(t, h);
	await createBatchWithdrawalTasks(task => task)[0].run(first.ctx, h.input);
	h.advance();
	const input = { batchFile: first.file, network: h.input.network, chainId: h.input.chainId };
	const readCtx = {
		...first.ctx,
		state: { ...first.ctx.state, risk: "read-only" },
		step: async (id, title, fn) => fn(),
		bindSigner: () => {
			throw new Error("read-only check cannot bind a signer");
		},
	};
	const count = h.stats().sends;
	await createBatchWithdrawalTasks(task => task)[1].run(readCtx, input);
	assert.equal(h.stats().sends, count);
	first.ctx.step = async (id, title, fn) => fn();
	await createBatchWithdrawalTasks(task => task)[2].run(first.ctx, input);
	assert.equal(h.stats().sends, count + 2);
	assert.equal(h.stats().fetches, 1);
	assert.equal(h.row(account).status, "completed");
	assert.equal(h.row(waiting).status, "completed");
});
test("completed batch history preserves public suggestions and returns its saved report", async t => {
	const h = batchHarness({ count: 1 }),
		c = context(t, h);
	await createBatchWithdrawalTasks(task => task)[0].run(c.ctx, h.input);
	const stateRoot = path.join(c.scratch, "state"),
		archived = path.join(stateRoot, "history", "run");
	fs.mkdirSync(archived, { recursive: true });
	fs.writeFileSync(
		path.join(archived, "state.json"),
		JSON.stringify({
			taskId: "maintenance.batch-withdrawal",
			status: "completed",
			finishedAt: "2026-10-04T12:00:00Z",
			eventPath: c.ctx.state.eventPath,
		}),
	);
	const rows = batchHistory(stateRoot);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].file, c.file);
	assert.equal(rows[0].input.network, "localhost");
	const suggestions = ui();
	const prepared = await prepareBatch({ ui: suggestions, stateRoot });
	assert.equal(prepared.network, h.input.network);
	assert.equal(prepared.muonUrl, h.input.muonUrl);
	assert.deepEqual(prepared.accounts, h.input.accounts);
	const changed = ui({
		"Batch Core diamond address": "0x" + "d".repeat(40),
		"Account addresses separated by commas or spaces": h.addresses.join(","),
	});
	const newCore = await prepareBatch({ ui: changed, stateRoot });
	assert.equal(newCore.muonUrl, "https://muon-oracle3.rasa.capital/");
	assert.equal(changed.prompts.find(prompt => prompt.message === "Account addresses separated by commas or spaces").initialValue, undefined);
});
test("the ready pass resumes uncertain fresh and adopted finalizations before deciding whether to send", async t => {
	for (const adopted of [false, true]) {
		const h = batchHarness({ count: 1 }),
			account = h.addresses[0];
		if (adopted) h.request(account, 1_000_000n);
		else h.states.get(account).allocated = 10n ** 18n;
		const c = context(t, h);
		await createBatchWithdrawalTasks(task => task)[0].run(c.ctx, h.input);
		h.advance();
		c.completed.clear();
		h.timeout(true);
		const input = { batchFile: c.file, network: h.input.network, chainId: h.input.chainId };
		const ready = createBatchWithdrawalTasks(task => task)[2];
		await assert.rejects(ready.run(c.ctx, input), /uncertain transactions/);
		const row = h.row(account),
			operation = adopted ? row.requests[1].operations.finalize : row.fresh.operations.withdraw;
		const hash = operation.hash;
		delete operation.hash;
		operation.status = "prepared";
		c.save();
		h.timeout(false);
		const text = c.ctx.ui.text;
		c.ctx.ui.text = async question => (question.message.startsWith("Original or replacement") ? hash : text(question));
		const sends = h.stats().sends;
		await ready.run(c.ctx, input);
		assert.equal(h.stats().sends, sends);
		assert.equal(h.row(account).status, "completed");
		assert(c.calls.some(call => call.phase === "reconcile" && !call.execute));
	}
});
