import {
	TARGET,
	SELECTOR,
	LEGACY_SELECTOR,
	REQUIRED_CHECKS,
	SOURCE_FILES,
	iface,
	digest,
	sourceDigest,
	planCut,
	validateInput,
	requireValidation,
	requireRecipientConfirmation,
	recoveryEvent,
	recoveryAction,
} from "../../deployment-tooling/hyperevm-zero-recovery.js";
import { createHyperEvmZeroRecoveryTask } from "../tasks/hyperevm-zero-recovery.js";
import { ZeroAddress, keccak256 } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const facet = "0x1111111111111111111111111111111111111111";
const baseline = { [LEGACY_SELECTOR]: TARGET.legacyAccountFacet, "0x12345678": TARGET.owner };
const inputFor = forkEnabled => ({
	schema: 1,
	target: TARGET,
	forkEnabled,
	rpcKey: "RPC_HYPEREVM",
	...(forkEnabled ? { archiveRpcKey: "ARCHIVE" } : {}),
	sourceDigest: "source",
});
const artifact = { deployedBytecode: "0x6000" };

test("adds exactly one selector with no initializer and refuses selector drift", () => {
	const [a] = planCut(baseline, baseline, facet);
	const [cut, init, data] = iface.decodeFunctionData("diamondCut", a.data);
	assert.equal(a.to, TARGET.core);
	assert.equal(a.value, "0");
	assert.equal(cut.length, 1);
	assert.equal(cut[0].action, 0n);
	assert.deepEqual([...cut[0].functionSelectors], [SELECTOR]);
	assert.equal(init, ZeroAddress);
	assert.equal(data, "0x");
	assert.deepEqual(planCut(baseline, { ...baseline, [SELECTOR]: facet }, facet), []);
	for (const current of [
		{ ...baseline, "0x12345678": facet },
		{ ...baseline, "0x44444444": facet },
		{ [SELECTOR]: facet },
		{ ...baseline, [SELECTOR]: TARGET.owner },
	])
		assert.throws(() => planCut(baseline, current, facet), /changed outside/);
	assert.throws(() => planCut({ ...baseline, [SELECTOR]: facet }, baseline, facet), /Invalid/);
});
test("fork is optional, off by default, and does not require an archive key", () => {
	const input = inputFor(false);
	validateInput(input);
	assert.throws(() => validateInput({ ...input, forkEnabled: undefined }), /Choose whether/);
	assert.throws(() => validateInput({ ...input, rpcKey: "https://secret.example" }), /key names/);
	assert.throws(() => validateInput({ ...input, forkEnabled: true }), /key names/);
	const local = { localTests: { passed: true, inputDigest: digest(input), sourceDigest: input.sourceDigest } };
	requireValidation(local, input, artifact);
	assert.throws(() => requireValidation({}, input, artifact), /local recovery tests/);
	const task = createHyperEvmZeroRecoveryTask(v => v);
	assert.equal(
		task.plan({}, {}).some(s => s.id === "rehearse"),
		false,
	);
	assert.equal(
		task.plan({}, { forkEnabled: true }).some(s => s.id === "rehearse"),
		true,
	);
});
test("an operator-requested fork must pass all guards for this exact input and artifact", () => {
	const input = inputFor(true),
		report = { localTests: { passed: true, inputDigest: digest(input), sourceDigest: input.sourceDigest } };
	assert.throws(() => requireValidation(report, input, artifact), /fork rehearsal/);
	report.rehearsal = {
		passed: true,
		inputDigest: digest(input),
		runtimeHash: keccak256(artifact.deployedBytecode),
		archiveVerified: true,
		blockHash: "0x01",
		blockNumber: 100,
		checks: [...REQUIRED_CHECKS],
	};
	requireValidation(report, input, artifact);
	for (const missing of REQUIRED_CHECKS)
		assert.throws(
			() =>
				requireValidation(
					{ ...report, rehearsal: { ...report.rehearsal, checks: REQUIRED_CHECKS.filter(c => c !== missing) } },
					input,
					artifact,
				),
			/fork rehearsal/,
		);
	assert.throws(() => requireValidation(report, input, { deployedBytecode: "0x6001" }), /fork rehearsal/);
});
test("operator confirmation requires only the exact recipient and confirmation date", () => {
	const valid = { recipient: TARGET.recipient, confirmedAt: "2026-09-17T10:00:00Z" };
	requireRecipientConfirmation(valid);
	for (const field of Object.keys(valid)) assert.throws(() => requireRecipientConfirmation({ ...valid, [field]: "" }), /Operator confirmation/);
	assert.throws(() => requireRecipientConfirmation({ ...valid, recipient: TARGET.owner }), /Operator confirmation/);
});
const eventLog = (amount = 200981026302519456100n, recipient = TARGET.recipient, before = 4605160364884342n, after = before + amount) => ({
	address: TARGET.core,
	...iface.encodeEventLog(iface.getEvent("ZeroAddressBalanceRecovered"), [TARGET.recipient, recipient, amount, before, after]),
});
test("receipt evidence preserves every raw unit and rejects wrong/duplicate/malformed evidence", () => {
	const good = eventLog();
	const result = recoveryEvent({ status: 1, logs: [good] });
	assert.equal(result.amount, "200981026302519456100");
	assert.equal(result.recipientAfter, "200985631462884340442");
	assert.equal(result.zeroAfter, "0");
	for (const receipt of [
		{ status: 0, logs: [good] },
		{ status: 1, logs: [] },
		{ status: 1, logs: [good, good] },
		{ status: 1, logs: [{ ...good, address: facet }] },
		{ status: 1, logs: [eventLog(1n, TARGET.owner)] },
		{ status: 1, logs: [eventLog(1n, TARGET.recipient, 0n, 0n)] },
		{ status: 1, logs: [eventLog(0n)] },
	])
		assert.throws(() => recoveryEvent(receipt));
});
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "zero-recovery-cli-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const file of SOURCE_FILES) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), "fixture");
	}
	return root;
}
test("prepare defaults to no fork and never asks for archive credentials", async t => {
	const root = fixture(t),
		task = createHyperEvmZeroRecoveryTask(v => v),
		prompts = [];
	const input = await task.prepare({
		root,
		ui: {
			confirm: async p => {
				assert.equal(p.initialValue, false);
				return false;
			},
			text: async p => {
				prompts.push(p.message);
				return p.initialValue;
			},
			note: () => {},
		},
	});
	assert.equal(input.forkEnabled, false);
	assert.equal(input.archiveRpcKey, undefined);
	assert.equal(prompts.length, 1);
	validateInput(JSON.parse(fs.readFileSync(input.input)), root);
});
test("local recovery tests cannot add mock transactions to the live task journal", async t => {
	const root = fixture(t),
		task = createHyperEvmZeroRecoveryTask(v => v),
		standard = { ...inputFor(false), sourceDigest: sourceDigest(root) },
		input = { ...standard, inputDigest: digest(standard), input: path.join(root, "input.json"), output: path.join(root, "report.json") };
	fs.writeFileSync(input.input, JSON.stringify(standard));
	const calls = [];
	await task.run(
		{
			root,
			step: async (id, _title, fn) => {
				if (id === "test") await fn();
			},
			runProcess: async (_exe, args, options) => calls.push({ args, options }),
		},
		input,
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[0], "test");
	assert.equal(calls[0].options.captureEvents, false);
	assert.equal(calls[0].options.env.SYMMIO_RECOVERY_EXECUTE, "false");
	assert.equal(JSON.parse(fs.readFileSync(input.output)).localTests.passed, true);
});
test("resume completes after recovery verification, cleanup and summary without communication prompts", async t => {
	const root = fixture(t),
		task = createHyperEvmZeroRecoveryTask(v => v);
	const standard = { ...inputFor(false), sourceDigest: sourceDigest(root) },
		input = { ...standard, inputDigest: digest(standard), input: path.join(root, "input.json"), output: path.join(root, "report.json") };
	fs.writeFileSync(input.input, JSON.stringify(standard));
	const report = {
		inputDigest: input.inputDigest,
		safeDelivery: { builderPath: "existing.json" },
		localTests: { passed: true },
		recipientConfirmation: { recipient: TARGET.recipient, confirmedAt: new Date().toISOString() },
	};
	fs.writeFileSync(input.output, JSON.stringify(report));
	const completed = new Set(["compile", "test", "inspect", "recipient", "authorize", "deploy", "publish", "cut", "grant"]),
		phases = [],
		prompts = [];
	const ctx = {
		root,
		state: {},
		getSigner: () => {
			throw new Error("No signer should be needed");
		},
		ui: {
			text: async p => {
				prompts.push(p.message);
				assert.match(p.message, /transaction hash/);
				return "0x" + "1".repeat(64);
			},
			note: () => {},
		},
		step: async (id, _title, fn) => {
			if (!completed.has(id)) {
				await fn();
				completed.add(id);
			}
		},
		runProcess: async (_exe, args, { env }) => {
			assert.equal(env.SYMMIO_RECOVERY_ARCHIVE_KEY, "");
			assert.equal(env.SYMMIO_RECOVERY_EXECUTE, "false");
			const phase = args[args.indexOf("--phase") + 1];
			phases.push(phase);
			const current = JSON.parse(fs.readFileSync(input.output));
			if (phase === "verify-recovery") current.recovery = { transactionHash: "0x" + "1".repeat(64) };
			if (phase === "evidence") {
				current.summaryFile = path.join(root, "recovery-summary.txt");
				fs.writeFileSync(current.summaryFile, "Recovery verified");
			}
			fs.writeFileSync(input.output, JSON.stringify(current));
		},
		wait: () => {
			throw new Error("Unexpected wait");
		},
	};
	await task.run(ctx, input);
	assert.deepEqual(phases, ["verify-recovery", "cleanup", "evidence"]);
	assert.equal(completed.has("evidence"), true);
	assert.equal(prompts.length, 1);
	assert.equal(prompts.filter(p => p.includes("transaction hash")).length, 1);
});
test("skipping the optional fork retains local tests and recipient confirmation, with verification as the final step", () => {
	const task = createHyperEvmZeroRecoveryTask(v => v),
		ids = task.plan({}, { forkEnabled: false }).map(s => s.id);
	assert.deepEqual(ids.slice(0, 5), ["compile", "test", "inspect", "recipient", "authorize"]);
	assert.ok(ids.indexOf("recovery") < ids.indexOf("cleanup"));
	assert.equal(ids.at(-1), "evidence");
});

test("first Safe export contains only the full-balance recovery call and waits without marking execution complete", async t => {
	const root = fixture(t),
		task = createHyperEvmZeroRecoveryTask(v => v);
	const standard = { ...inputFor(false), sourceDigest: sourceDigest(root) },
		input = { ...standard, inputDigest: digest(standard), input: path.join(root, "input.json"), output: path.join(root, "report.json") };
	fs.writeFileSync(input.input, JSON.stringify(standard));
	fs.writeFileSync(input.output, JSON.stringify({ inputDigest: input.inputDigest }));
	const completed = new Set(["compile", "test", "inspect", "recipient", "authorize", "deploy", "publish", "cut", "grant"]);
	const ctx = {
		root,
		state: { runId: "recovery-test" },
		ui: { note: () => {} },
		emit: () => {},
		step: async (id, _title, fn) => {
			if (!completed.has(id)) {
				await fn();
				completed.add(id);
			}
		},
		runProcess: async (_exe, args) => {
			assert.equal(args[args.indexOf("--phase") + 1], "plan-recovery");
			fs.writeFileSync(
				input.output,
				JSON.stringify({
					inputDigest: input.inputDigest,
					preview: {
						snapshot: { zero: "1234567890123456789", recipient: "1" },
						action: recoveryAction(),
					},
				}),
			);
		},
		wait: message => {
			throw new Error(message);
		},
	};
	await assert.rejects(task.run(ctx, input), /Import .*recipient Safe/);
	const report = JSON.parse(fs.readFileSync(input.output));
	const batch = JSON.parse(fs.readFileSync(report.safeDelivery.builderPath));
	assert.equal(batch.chainId, "999");
	assert.equal(batch.transactions.length, 1);
	const tx = batch.transactions[0];
	assert.equal(tx.to.toLowerCase(), TARGET.core.toLowerCase());
	assert.equal(tx.value, "0");
	assert.equal(iface.decodeFunctionData("recoverZeroAddressBalance", tx.data)[0], TARGET.recipient);
	assert.equal(completed.has("recovery"), false);
	assert.equal(report.recovery, undefined);
});
