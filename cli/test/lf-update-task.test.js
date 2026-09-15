import { SIGNER_MODES, selectSigner, signerEnvironment } from "../signer/index.js";
import { LF_DEPLOYMENTS, LF_STEPS, lfDirectory, lfEnvironment, readLfPlan, reconcileLfTask } from "../tasks/lf-update.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const definition = TASK_DEFINITIONS.find(item => item.id === "maintenance.update-symbol-lf");
const operator = "0x1111111111111111111111111111111111111111";
const stable = value =>
	Array.isArray(value)
		? value.map(stable)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map(key => [key, stable(value[key])]),
				)
			: value;
const seal = value => ({
	...value,
	digest: `sha256:${createHash("sha256")
		.update(JSON.stringify(stable(value)))
		.digest("hex")}`,
});
const write = (file, value) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
};
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-task-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const input = {
		...LF_DEPLOYMENTS[0],
		chainId: 8453,
		authority: operator,
		batchSize: 50,
		announcementReference: "announcement-123",
		enforcementAt: "2026-09-15T00:00:00Z",
		signer: { mode: SIGNER_MODES.KEYSTORE, key: "LF_OPERATOR", address: operator },
	};
	const calls = [],
		notes = [],
		completed = new Set();
	const row = { symbolId: "1", name: "BTCUSD", minAcceptableQuoteValue: "5", minAcceptablePortionLF: "1", targetLF: "30000000000000000" };
	const ctx = {
		state: { eventPath: path.join(root, "events.ndjson"), transactions: [] },
		ui: { note: (...args) => notes.push(args), text: async options => options.initialValue ?? "8453" },
		checkpoint() {},
		requestPause() {
			throw new Error("paused");
		},
		wait(message) {
			throw new Error(`waiting: ${message}`);
		},
		async step(id, title, action) {
			assert.equal(title, LF_STEPS.find(step => step.id === id).title);
			if (!completed.has(id)) {
				await action();
				completed.add(id);
			}
		},
		async runProcess(_cmd, args, { env }) {
			calls.push({ args, env });
			const dir = lfDirectory(ctx);
			if (env.LF_UPDATE_PHASE === "inspect")
				write(path.join(dir, "snapshot.json"), seal({ symbols: [row], classification: { btcEthIds: ["1"], ambiguousIds: [] } }));
			if (env.LF_UPDATE_PHASE === "plan") write(path.join(dir, "plan.json"), seal({ rows: [row], btcEthIds: ["1"] }));
			if (env.LF_UPDATE_PHASE === "apply") {
				if (env.EXECUTE === "true") ctx.executed = true;
				const status =
					env.EXECUTE === "true" ? ctx.executionStatus || "complete" : ctx.executed ? ctx.verificationStatus || "complete" : "ready";
				write(path.join(dir, "report.json"), {
					apiVersion: "operations.symm.io/lf-report-v1",
					status,
					planDigest: ctx.state.lfPlanDigest,
					authority: operator,
					transactions: [],
					pending: status === "complete" ? 0 : 1,
					total: 1,
					completed: status === "complete" ? 1 : 0,
					verification: status === "complete" ? { symbols: [row] } : undefined,
					block: { number: 123 },
					nextEligibleAt: "2026-09-16T00:00:00Z",
				});
			}
			if (env.LF_UPDATE_PHASE === "reconcile") for (const tx of ctx.state.transactions) tx.status = "confirmed";
		},
	};
	return { ctx, input, calls, notes, completed };
}
test("LF task declares the standard transaction, signer and recovery contract", () => {
	assert.ok(definition);
	assert.equal(definition.handler, definition.run);
	assert.equal(definition.transactionJournal, true);
	assert.deepEqual(definition.plan(), LF_STEPS);
	assert.deepEqual(definition.resumePolicy, { strategy: "stable-step-id", sourceDrift: "confirm", inputDrift: "refuse" });
	assert.equal(definition.cancellationPolicy.reconcileSubmittedTransactions, true);
	assert.deepEqual(definition.signerPolicy.allowedModes, [SIGNER_MODES.KEYSTORE]);
	assert.deepEqual(
		LF_DEPLOYMENTS.map(item => item.id),
		["base-085", "arbitrum-085", "arbitrum-0862", "bsc-085"],
	);
});
test("existing-keystore selection neither requests secrets nor refreshes stored keys", async () => {
	const prompts = [];
	const selection = await selectSigner(
		{
			note() {},
			text: async opts => {
				prompts.push(opts);
				return "LF_OPERATOR";
			},
			confirm: async () => {
				throw new Error("Must not ask to replace the key");
			},
			runInteractive: async () => {
				throw new Error("Must not invoke keystore set");
			},
			password: async () => {
				throw new Error("No password needed to select the key");
			},
		},
		{ allowedModes: [SIGNER_MODES.KEYSTORE], existingKeystoreOnly: true, expectedAddress: operator },
	);
	assert.deepEqual(selection, { mode: SIGNER_MODES.KEYSTORE, key: "LF_OPERATOR", address: operator });
	assert.equal(prompts.length, 1);
	assert.equal(signerEnvironment(selection).USE_KEYSTORE, "true");
});
test("Base preparation uses the supplied wallet, existing key name and RPC_BASE", async () => {
	const answers = [
		LF_DEPLOYMENTS[0].core,
		LF_DEPLOYMENTS[0].symbolManager,
		operator,
		"50",
		"announcement-123",
		"2026-09-15T00:00:00Z",
		"LF_OPERATOR",
	];
	const notes = [];
	const input = await definition.prepare({
		ui: {
			select: async () => "base-085",
			text: async () => answers.shift(),
			note: (...args) => notes.push(args),
			confirm: async () => {
				throw new Error("No credential setup expected");
			},
		},
	});
	assert.equal(input.chainId, 8453);
	assert.equal(input.signer.key, "LF_OPERATOR");
	assert.equal(input.signer.address, operator);
	assert.match(notes.flat().join(" "), /RPC_BASE/);
	assert.equal(input.announcementReference, "announcement-123");
});
test("adapter uses keystore credentials and defaults to no execution", t => {
	const { ctx, input } = fixture(t);
	const env = lfEnvironment(ctx, input, "apply");
	assert.equal(env.USE_KEYSTORE, "true");
	assert.equal(env.KEYSTORE_DEPLOYER_KEY, "LF_OPERATOR");
	assert.equal(env.SYMMIO_EXPECTED_SIGNER, operator);
	assert.equal(env.EXECUTE, "false");
	assert.equal(env.CONFIRM_CHAIN_ID, "");
	assert.equal(env.SYMMIO_RPC_URL_OVERRIDE, "");
	assert.equal(env.SYMMIO_DEPLOYMENT_RECIPE, "");
	assert.equal(env.DOTENV_CONFIG_PATH, "/dev/null");
	assert.equal(lfEnvironment(ctx, input, "apply", true).CONFIRM_CHAIN_ID, "8453");
	assert.throws(() => lfEnvironment(ctx, { ...input, signer: { mode: SIGNER_MODES.PRIVATE_KEY } }, "apply"), /keystore/);
});
test("review, dry run, confirmation, writes and final reads occur in order", async t => {
	const { ctx, input, calls, notes, completed } = fixture(t);
	await definition.run(ctx, input);
	assert.deepEqual([...completed], ["inspect", "authorize", "apply", "verify"]);
	assert.deepEqual(
		calls.map(call => [call.env.LF_UPDATE_PHASE, call.env.EXECUTE]),
		[
			["inspect", "false"],
			["plan", "false"],
			["apply", "false"],
			["apply", "true"],
			["apply", "false"],
		],
	);
	assert.match(notes.flat().join(" "), /announcement-123/);
	assert.match(notes.flat().join(" "), /preview.csv/);
});
test("quota pause resumes the reviewed plan without recollecting credentials or classifications", async t => {
	const { ctx, input, completed, calls } = fixture(t);
	ctx.executionStatus = "waiting-daily-limit";
	await assert.rejects(definition.run(ctx, input), /Continue active task/);
	assert.deepEqual([...completed], ["inspect", "authorize"]);
	ctx.executionStatus = "complete";
	await definition.run(ctx, input);
	assert.equal(calls.filter(call => call.env.LF_UPDATE_PHASE === "inspect").length, 1);
	assert.equal(calls.filter(call => call.env.LF_UPDATE_PHASE === "plan").length, 1);
});
test("failed final proof and edited plans cannot report completion", async t => {
	const { ctx, input, completed } = fixture(t);
	ctx.verificationStatus = "ready";
	await assert.rejects(definition.run(ctx, input), /verification is incomplete/);
	assert.equal(completed.has("verify"), false);
	const file = path.join(lfDirectory(ctx), "plan.json"),
		plan = JSON.parse(fs.readFileSync(file));
	plan.rows[0].minAcceptableQuoteValue = "0";
	write(file, plan);
	assert.throws(() => readLfPlan(ctx), /plan changed/);
	assert.throws(() => definition.validateResume({ state: ctx.state }, input), /plan changed/);
});
test("cancellation recovers missing adapter records from the runner transaction journal", async t => {
	const { ctx, input } = fixture(t);
	ctx.state.lfPlanDigest = "sha256:reviewed";
	ctx.state.transactions.push({ hash: "0x" + "ab".repeat(32), status: "unresolved" });
	assert.deepEqual(await reconcileLfTask(ctx, input), { unresolved: [] });
	const report = JSON.parse(fs.readFileSync(path.join(lfDirectory(ctx), "report.json")));
	assert.equal(report.transactions.length, 1);
});
test("successful batch windows do not launch reconciliation or replay completed preparation", async t => {
	const { ctx, input, calls } = fixture(t);
	const runProcess = ctx.runProcess.bind(ctx);
	let windows = 0;
	ctx.runProcess = async (cmd, args, options) => {
		const executing = options.env.LF_UPDATE_PHASE === "apply" && options.env.EXECUTE === "true";
		if (executing) ctx.executionStatus = ++windows < 3 ? "ready" : "complete";
		await runProcess(cmd, args, options);
		if (executing) {
			const file = path.join(lfDirectory(ctx), "report.json");
			const report = JSON.parse(fs.readFileSync(file));
			report.pending = 3 - windows;
			report.transactions = [{ hash: "0x" + String(windows).repeat(64), status: "confirmed" }];
			write(file, report);
			ctx.state.transactions = report.transactions;
		}
	};
	await definition.run(ctx, input);
	assert.equal(windows, 3);
	assert.equal(calls.filter(call => call.env.LF_UPDATE_PHASE === "reconcile").length, 0);
	assert.equal(calls.filter(call => call.env.LF_UPDATE_PHASE === "inspect").length, 1);
	await reconcileLfTask(ctx, input);
	assert.equal(calls.filter(call => call.env.LF_UPDATE_PHASE === "reconcile").length, 0);
});
