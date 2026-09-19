import { digest } from "../../deployment-tooling/disputed-settlement.js";
import {
	createDisputedSettlementTask,
	readSettlementReport,
	runSettlementAdapter,
	settlementEnvironment,
	settlementPreview,
	SETTLEMENT_STEPS,
} from "../tasks/disputed-settlement.js";
import { settlementFixture } from "./fixtures/disputed-settlement.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("share-file preparation copies exact rules and binds the Ledger signer to the input operator", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispute-task-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const f = settlementFixture(),
		task = createDisputedSettlementTask(x => x);
	fs.writeFileSync(path.join(root, "case.json"), JSON.stringify(f.input));
	const input = await task.prepare({
		root,
		ui: {
			text: async q => {
				assert.equal(q.validate("case.json"), undefined);
				return "case.json";
			},
			select: async () => "keystore",
			note() {},
		},
	});
	assert.equal(input.inputDigest, digest(f.input));
	assert.deepEqual(JSON.parse(fs.readFileSync(input.input)), f.input);
	assert.equal(task.signerPolicy(input).expectedAddress, f.input.operator);
	assert.equal(task.signerPolicy(input).initialMode, "ledger");
	assert.deepEqual(
		task.plan().map(s => s.id),
		SETTLEMENT_STEPS.map(s => s.id),
	);
	fs.writeFileSync(input.output, JSON.stringify({ inputDigest: input.inputDigest, plan: f.plan() }));
	assert(readSettlementReport(input).plan);
	const edited = { ...f.input, operator: f.input.partyA };
	fs.writeFileSync(input.input, JSON.stringify(edited));
	assert.throws(() => readSettlementReport(input), /changed/);
});

test("read-only adapter environment cannot inherit transaction opt-ins or a signer", () => {
	const input = { chainId: 42161, rpcSource: "keystore" };
	const read = settlementEnvironment(input);
	assert.equal(read.EXECUTE, "false");
	assert.equal(read.CONFIRM_CHAIN_ID, "");
	assert.equal(read.SYMMIO_SIGNER_MODE, "");
	assert.equal(read.SYMMIO_RECIPE_READ_ONLY, "true");
	assert.equal(read.DOTENV_CONFIG_PATH, "/dev/null");
	const write = settlementEnvironment(input, true);
	assert.equal(write.EXECUTE, "true");
	assert.equal(write.CONFIRM_CHAIN_ID, "42161");
});

test("admin preview shows exact formulas, parent, chain, signer, target and every calldata", () => {
	const p = settlementFixture().plan(),
		preview = settlementPreview(p);
	for (const value of [
		"2.493108170448664277",
		"0.053876144664567485",
		"0.895588429244244328",
		"3.44257274435747609",
		"0.579974554669831643",
		"× 10000/10000",
		"explicitly disabled",
		"18 decimals",
		p.baseline.virtual.parentAccount,
		p.input.operator,
		p.input.core,
		"42161",
		...p.actions.map(a => a.data),
	])
		assert(preview.includes(value), value);
});

test("cancellation preserves an unknown pre-signing outcome without inventing a transaction", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispute-cancel-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const f = settlementFixture(),
		input = { input: path.join(root, "input.json"), output: path.join(root, "report.json"), inputDigest: digest(f.input) };
	fs.writeFileSync(input.input, JSON.stringify(f.input));
	fs.writeFileSync(
		input.output,
		JSON.stringify({ inputDigest: input.inputDigest, plan: f.plan(), operations: { payment: { status: "prepared", nonce: 9 } } }),
	);
	const result = await createDisputedSettlementTask(x => x).reconcile({ runProcess: () => assert.fail("must not send") }, input);
	assert.deepEqual(result.unresolved, ["payment: unknown transaction at nonce 9"]);
});

test("receipt recovery restores a missing CLI journal entry without duplication or signing", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispute-journal-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const f = settlementFixture(),
		input = {
			input: path.join(root, "input.json"),
			output: path.join(root, "report.json"),
			inputDigest: digest(f.input),
			chainId: 42161,
			network: "arbitrum",
			rpcSource: "keystore",
		};
	fs.writeFileSync(input.input, JSON.stringify(f.input));
	fs.writeFileSync(
		input.output,
		JSON.stringify({
			inputDigest: input.inputDigest,
			plan: f.plan(),
			operations: { grant: { status: "confirmed", hash: "0x" + "ab".repeat(32), nonce: 9, intent: { from: f.input.operator } } },
		}),
	);
	const state = { transactions: [] },
		ctx = {
			state,
			runProcess: async (_command, _args, options) => {
				assert.equal(options.env.EXECUTE, "false");
			},
			emit: (type, { transaction }) => {
				if (type === "tx.submitted") state.transactions.push(transaction);
			},
		};
	await runSettlementAdapter(ctx, input, "grant");
	await runSettlementAdapter(ctx, input, "grant");
	assert.equal(state.transactions.length, 1);
	assert.equal(state.transactions[0].status, "confirmed");
});
