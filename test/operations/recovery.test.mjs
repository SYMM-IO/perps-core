import { createTaskRunner } from "../../cli/task-runner.js";
import { registerRedactionSecrets, sanitizeEvidence, redactText } from "../../deployment-tooling/operations/redaction.js";
import { hashSourceTree } from "../../deployment-tooling/operations/source-manifest.js";
import { createDeploymentManifest } from "../../tasks/deploy/checkpoint.ts";
import { getDeploymentTransactionJournal, resetDeploymentTransactionJournal, send, observeDeploymentTransaction } from "../../tasks/deploy/tx.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const hash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;

test("keystore redaction uses a scoped zeroable buffer and masks quoted/Bearer credentials", () => {
	const bytes = Buffer.from("bare keystore fixture password\n");
	const clear = registerRedactionSecrets([bytes]);
	assert.equal(redactText("Rejected bare keystore fixture password"), "Rejected <redacted-secret>");
	bytes.fill(0);
	clear();
	assert.equal(redactText("Rejected bare keystore fixture password"), "Rejected bare keystore fixture password");
	assert.doesNotMatch(redactText('password="fixture with spaces" Authorization: Bearer abcdefghi'), /fixture with spaces|abcdefghi/);
});
const from = `0x${"1".repeat(40)}`;
const to = `0x${"2".repeat(40)}`;
const intent = {
	hash,
	from,
	to,
	data: "0x1234",
	value: "0",
	nonce: 1,
	confirmations: 1,
	status: "unresolved",
	submittedAt: new Date().toISOString(),
	durationMs: 0,
	label: "fixture",
};

test("shared manifest binds schema/utility changes and excludes mutable evidence", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-manifest-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const file of ["deployment-tooling/schema.json", "utils/shared.ts", "tasks/data/checkpoint.json", "scripts/upgrade/output/report.json"]) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), "original");
	}
	const originalCwd = process.cwd();
	try {
		process.chdir(root);
		const initial = createDeploymentManifest({ chainId: 1 }, { deploymentId: "fixture" });
		assert.equal(initial.sourceHash, hashSourceTree(root));
		fs.writeFileSync("tasks/data/checkpoint.json", "new journal");
		fs.writeFileSync("scripts/upgrade/output/report.json", "new report");
		assert.equal(createDeploymentManifest({ chainId: 1 }).fingerprint, initial.fingerprint);
		fs.writeFileSync("deployment-tooling/schema.json", "schema change");
		assert.notEqual(createDeploymentManifest({ chainId: 1 }).fingerprint, initial.fingerprint);
		const changed = hashSourceTree(root);
		fs.writeFileSync("utils/shared.ts", "helper change");
		assert.notEqual(hashSourceTree(root), changed);
		assert.throws(() => hashSourceTree(root, ["../outside"]), /escapes/);
	} finally {
		process.chdir(originalCwd);
	}
});

test("real receipt error is sanitized before structured events, state, history and UI", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-redaction-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const secret = "transient-signer-password-fixture";
	registerRedactionSecrets([secret]);
	const message = `provider https://user:credential@rpc.invalid/token private_key=0x${"c".repeat(64)} password=${secret} api_key=fixture-key`;
	const publicData = `0x${"c".repeat(64)}`;
	resetDeploymentTransactionJournal();
	const run = async ctx => {
		ctx.emit("tx.submitted", { transaction: { ...intent, data: publicData } });
		try {
			await send(
				Promise.resolve({
					...intent,
					data: publicData,
					wait: async () => {
						throw new Error(message);
					},
				}),
				"fixture",
			);
		} catch {
			ctx.emit("tx.failed", { transaction: getDeploymentTransactionJournal()[0] });
		}
		ctx.emit("warning", { message, nested: { error: message, apiKey: "fixture-key", input: { password: "fixture-key" } } });
		const childRecord = `${JSON.stringify({ type: "warning", detail: { message } })}\n`;
		await ctx.runProcess(process.execPath, ["-e", `require('node:fs').writeSync(3, ${JSON.stringify(childRecord)})`]);
		ctx.captureLine(message);
		throw new Error(message);
	};
	const definition = {
		id: "maintenance.fixture",
		version: 1,
		title: "Fixture",
		description: "Fixture",
		category: "maintenance",
		risk: "transaction",
		supportedNetworks: ["any"],
		inputs: [],
		artifacts: ["journal"],
		prepare: async () => ({}),
		plan: async () => [{ id: "fixture", phase: "execution", title: "Fixture" }],
		run,
		handler: run,
		transactionJournal: true,
		resumePolicy: { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" },
		cancellationPolicy: { rollback: false, reconcileSubmittedTransactions: true, unresolvedOutcome: "cancel_pending" },
		reconcile: () => ({ unresolved: [hash] }),
	};
	const seen = [];
	const runner = createTaskRunner({ root, definitions: [definition] });
	const state = await runner.start(definition.id, { onEvent: (event, state) => seen.push(structuredClone({ event, state })) });
	assert.match(state.lastError, /^provider <redacted-url>/);
	assert.ok(seen.filter(item => item.event.type === "warning").length >= 2, "structured child warning reached the parent");
	for (const output of [
		JSON.stringify(state),
		JSON.stringify(seen),
		fs.readFileSync(state.eventPath, "utf8"),
		fs.readFileSync(state.logPath, "utf8"),
		fs.readFileSync(path.join(root, ".symmio/tasks/active.json"), "utf8"),
	]) {
		assert.doesNotMatch(output, /rpc\.invalid|transient-signer-password|fixture-key|private_key=0x/);
		assert.match(output, /redacted/);
	}
	assert.equal(state.transactions[0].hash, hash);
	assert.equal(state.transactions[0].data, publicData);
	const journal = getDeploymentTransactionJournal()[0];
	assert.doesNotMatch(journal.error, /rpc\.invalid|fixture-key|transient-signer/);
	// Finish after an independent observer has proved a failed transaction.
	const active = JSON.parse(fs.readFileSync(path.join(root, ".symmio/tasks/active.json")));
	active.transactions[0].status = "failed";
	fs.writeFileSync(path.join(root, ".symmio/tasks/active.json"), JSON.stringify(active));
	definition.reconcile = () => ({ unresolved: [] });
	const cancelled = await runner.cancelActive();
	assert.doesNotMatch(fs.readFileSync(cancelled.archivedPath, "utf8"), /rpc\.invalid|fixture-key|transient-signer/);
	assert.deepEqual(
		sanitizeEvidence({ data: publicData, constructorArgs: ["https://public-onchain-string.invalid"], authorization: "operator-confirmed" }),
		{ data: publicData, constructorArgs: ["https://public-onchain-string.invalid"], authorization: "operator-confirmed" },
	);
});

test("finalized observation reuses intent checks with zero mutations and no journal changes", async () => {
	const original = structuredClone(intent);
	let mutatingCalls = 0;
	const replacementHash = `0x${"d".repeat(64)}`;
	const provider = {
		getBlock: async () => ({ hash: blockHash }),
		getTransaction: async h => ({ ...intent, hash: h }),
		getTransactionReceipt: async h => ({ hash: h, blockHash, blockNumber: 9, status: 1 }),
		getCode: async () => "0x1234",
		sendTransaction: () => {
			mutatingCalls++;
			throw new Error("forbidden");
		},
		getTransactionCount: () => {
			mutatingCalls++;
			throw new Error("forbidden");
		},
	};
	assert.equal((await observeDeploymentTransaction(intent, provider, { number: 10, hash: blockHash })).status, "confirmed");
	assert.equal((await observeDeploymentTransaction({ ...intent, replacementHash }, provider, { number: 10, hash: blockHash })).status, "replaced");
	assert.equal((await observeDeploymentTransaction(intent, provider, { number: 10, hash })).status, "unknown");
	provider.getTransactionReceipt = async () => null;
	assert.equal((await observeDeploymentTransaction(intent, provider, { number: 10, hash: blockHash })).status, "unknown");
	assert.equal(mutatingCalls, 0);
	assert.deepEqual(intent, original);
});
