import {
	TARGET,
	EXECUTION,
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
import { createHyperEvmZeroRecoveryTask, PUBLIC_RPC, runRecoveryPhase, requireOwnerLedger } from "../tasks/hyperevm-zero-recovery.js";
import { ZeroAddress, keccak256 } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const facet = "0x1111111111111111111111111111111111111111";
const baseline = { [LEGACY_SELECTOR]: TARGET.legacyAccountFacet, "0x12345678": TARGET.owner };
const inputFor = forkEnabled => ({
	schema: 2,
	execution: EXECUTION,
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
const eventLog = (
	amount = 200981026302519456100n,
	recipient = TARGET.recipient,
	before = 4605160364884342n,
	after = before + amount,
	operator = TARGET.owner,
) => ({
	address: TARGET.core,
	...iface.encodeEventLog(iface.getEvent("ZeroAddressBalanceRecovered"), [operator, recipient, amount, before, after]),
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
		{ status: 1, logs: [eventLog(1n, TARGET.recipient, 0n, 1n, TARGET.recipient)] },
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
			select: async () => "custom",
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
for (const forkEnabled of [false, true])
	test(`public RPC needs no credentials and keeps the optional archive separate (fork: ${forkEnabled})`, async t => {
		const root = fixture(t),
			task = createHyperEvmZeroRecoveryTask(v => v),
			prompts = [];
		const input = await task.prepare({
			root,
			ui: {
				confirm: async () => forkEnabled,
				select: async p => {
					assert.equal(p.initialValue, "public");
					return "public";
				},
				text: async p => {
					prompts.push(p.message);
					return p.initialValue;
				},
				note: () => {},
			},
		});
		assert.equal(input.rpcKey, PUBLIC_RPC.key);
		assert.equal(prompts.length, forkEnabled ? 1 : 0);
		assert.equal(input.archiveRpcKey, forkEnabled ? "RPC_HYPEREVM_ARCHIVE" : undefined);
		validateInput(JSON.parse(fs.readFileSync(input.input)), root);
		fs.writeFileSync(input.output, JSON.stringify({ inputDigest: input.inputDigest }));
		let called = false;
		await runRecoveryPhase(
			{
				runProcess: async (_command, _args, { env }) => {
					called = true;
					assert.equal(env[PUBLIC_RPC.key], "https://rpc.hyperliquid.xyz/evm");
					assert.equal(env.RPC_HYPEREVM, undefined);
					assert.equal(env.SYMMIO_RECOVERY_RPC_KEY, PUBLIC_RPC.key);
					assert.equal(env.SYMMIO_RECOVERY_ARCHIVE_KEY, input.archiveRpcKey || "");
					assert.equal(env.SYMMIO_RECOVERY_EXECUTE, "false");
				},
			},
			input,
			"inspect",
		);
		assert.equal(called, true);
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
test("skipping the optional fork retains local tests and recipient confirmation, with verification as the final step", () => {
	const task = createHyperEvmZeroRecoveryTask(v => v),
		ids = task.plan({}, { forkEnabled: false }).map(s => s.id);
	assert.deepEqual(ids.slice(0, 5), ["compile", "test", "inspect", "recipient", "authorize"]);
	assert.ok(ids.indexOf("recovery") < ids.indexOf("cleanup"));
	assert.equal(ids.at(-1), "evidence");
});

const ledger = { mode: "ledger", address: TARGET.owner, derivation: "ledger-live" };
test("the task binds every new transaction to the owner Ledger", () => {
	const task = createHyperEvmZeroRecoveryTask(v => v);
	assert.deepEqual(task.signerPolicy().allowedModes, ["ledger"]);
	assert.equal(task.signerPolicy().expectedAddress, TARGET.owner);
	assert.equal(requireOwnerLedger(ledger), ledger);
	for (const selection of [{ ...ledger, address: TARGET.recipient }, { mode: "hardhat-keystore", key: "TEAM_DEPLOYER" }, undefined])
		assert.throws(() => requireOwnerLedger(selection), /requires Ledger/);
	assert.throws(() => validateInput({ ...inputFor(false), schema: 1, execution: undefined }), /target changed/);
});

for (const saved of ["new", "submitted", "confirmed", "verified", "safe-export"])
	test(`Ledger recovery resume handles ${saved} without another sweep or Safe signature prompt`, async t => {
		const root = fixture(t),
			task = createHyperEvmZeroRecoveryTask(v => v);
		const standard = { ...inputFor(false), sourceDigest: sourceDigest(root) };
		const input = {
			...standard,
			signer: ledger,
			inputDigest: digest(standard),
			input: path.join(root, "input.json"),
			output: path.join(root, "report.json"),
		};
		fs.writeFileSync(input.input, JSON.stringify(standard));
		const hash = "0x" + "1".repeat(64);
		const report = { inputDigest: input.inputDigest };
		if (["submitted", "confirmed", "verified"].includes(saved))
			report.operations = { recovery: { status: saved === "verified" ? "confirmed" : saved, nonce: 7, hash } };
		if (saved === "verified") report.recovery = { transactionHash: hash };
		if (saved === "safe-export") report.safeDelivery = { builderPath: "existing.json" };
		fs.writeFileSync(input.output, JSON.stringify(report));
		const phases = [],
			prompts = [];
		const ctx = {
			root,
			state: {},
			getSigner: () => null,
			ui: {
				note: () => {},
				text: async p => {
					prompts.push(p.message);
					assert.match(p.message, /interrupted.*hash/);
					return hash;
				},
			},
			step: async (id, _title, fn) => {
				if (id === "recovery") await fn();
			},
			runProcess: async (_exe, args, { env }) => {
				const phase = args[args.indexOf("--phase") + 1];
				phases.push(phase);
				assert.equal(env.SYMMIO_RECOVERY_EXECUTE, saved === "new" && phase === "recover" ? "true" : "false");
				if (phase === "recover" && saved === "new") {
					assert.equal(env.SYMMIO_SIGNER_MODE, "ledger");
					assert.equal(env.SYMMIO_EXPECTED_SIGNER, TARGET.owner);
				}
				if (phase === "plan-recovery") {
					const current = JSON.parse(fs.readFileSync(input.output));
					current.preview = { snapshot: { zero: "200981026302519456100", recipient: "4605160364884342" }, action: recoveryAction() };
					fs.writeFileSync(input.output, JSON.stringify(current));
				}
			},
			wait: message => {
				throw new Error(message);
			},
		};
		if (saved === "safe-export") return assert.rejects(task.run(ctx, input), /old Safe export/);
		await task.run(ctx, input);
		assert.deepEqual(phases, saved === "new" ? ["plan-recovery", "recover"] : saved === "verified" ? ["verify-recovery"] : ["recover"]);
		assert.equal(prompts.length, saved === "submitted" ? 1 : 0);
	});

test("deployment, upgrade, grant and cleanup reuse the single selected Ledger", async t => {
	const root = fixture(t),
		task = createHyperEvmZeroRecoveryTask(v => v);
	const standard = { ...inputFor(false), sourceDigest: sourceDigest(root) };
	const input = {
		...standard,
		signer: ledger,
		inputDigest: digest(standard),
		input: path.join(root, "input.json"),
		output: path.join(root, "report.json"),
	};
	fs.writeFileSync(input.input, JSON.stringify(standard));
	fs.writeFileSync(input.output, JSON.stringify({ inputDigest: input.inputDigest, temporaryRole: true, facet }));
	const phases = [];
	await task.run(
		{
			root,
			getSigner: () => null,
			ui: { note: () => {} },
			step: async (id, _title, fn) => {
				if (["deploy", "cut", "grant", "cleanup"].includes(id)) await fn();
			},
			runProcess: async (_exe, args, { env }) => {
				phases.push(args[args.indexOf("--phase") + 1]);
				assert.equal(env.SYMMIO_SIGNER_MODE, "ledger");
				assert.equal(env.SYMMIO_EXPECTED_SIGNER, TARGET.owner);
			},
		},
		input,
	);
	assert.deepEqual(phases, ["deploy", "cut", "grant", "cleanup"]);
});
