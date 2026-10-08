import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { publishUpgradeItems, rehearsalStatus, upgradeCompletionStatus } from "../../deployment-tooling/operations/upgrade-lifecycle.js";
import { createTaskRunner } from "../task-runner.js";
import { CORE_UPGRADE_PLAN, deliverCoreBatch } from "../tasks/arbitrum-core-upgrade.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { coreUpgradeFixture, read, write } from "./fixtures/core-upgrade.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

test("live upgrades omit fork steps and publish only after restoration", () => {
	const ids = CORE_UPGRADE_PLAN.map(step => step.id);
	assert.equal(
		ids.some(id => id.startsWith("rehearse-")),
		false,
	);
	assert.equal(ids.at(-1), "publish");
	assert.ok(ids.indexOf("deploy") < ids.indexOf("cut"));
	assert.ok(ids.indexOf("cut") < ids.indexOf("unpause"));
	assert.ok(ids.indexOf("cut") < ids.indexOf("muon-ready"));
	assert.ok(ids.indexOf("muon-ready") < ids.indexOf("unpause"));
});

test("standard upgrades preserve production availability and verify service without pause governance", () => {
	const task = TASK_DEFINITIONS.find(task => task.id === "maintenance.core-upgrade");
	const ids = task.plan({}, {}).map(step => step.id);
	assert.equal(ids.includes("pause"), false);
	assert.equal(ids.includes("unpause"), false);
	assert.ok(ids.indexOf("cut") < ids.indexOf("muon-ready"));
	assert.ok(ids.indexOf("muon-ready") < ids.indexOf("verify-service"));
	assert.equal(ids.at(-1), "publish");
});

test("standard Safe export contains only reviewed cut actions and refuses pause governance", async t => {
	const f = await coreUpgradeFixture(t, "safe");
	const report = read(f.input.output);
	report.batch = {
		actions: [{ to: f.config.target.core, value: "0", data: "0x1f931c1c", description: "Reviewed Core cut" }],
		envelope: { safeTxHash: "0x" + "a".repeat(64) },
	};
	write(f.input.output, report);
	const phases = [];
	const ctx = {
		root: f.root,
		state: { runId: "standard-safe-test" },
		ui: { note() {}, confirm: async () => true },
		emit() {},
		runProcess: async (_command, args) => phases.push(args[args.indexOf("--phase") + 1]),
		wait: message => {
			throw new Error(message);
		},
	};
	for (const key of ["pause", "unpause"]) await assert.rejects(deliverCoreBatch(ctx, f.input, key), /only cut governance/);
	await assert.rejects(deliverCoreBatch(ctx, f.input, "cut"), /ONE Safe transaction/);
	assert.deepEqual(Object.keys(ctx.state.safeDispatches), ["cut"]);
	assert.deepEqual(
		read(ctx.state.safeDispatches.cut.builderPath).transactions.map(tx => tx.data),
		["0x1f931c1c"],
	);
	assert.deepEqual(phases, ["check-export"]);
});

test("optional rehearsal evidence becomes outdated when its bindings change", () => {
	const bindings = { source: "reviewed", snapshot: "block-1" };
	assert.equal(rehearsalStatus(undefined, bindings), "not-run");
	assert.equal(rehearsalStatus({ status: "complete", bindings }, bindings), "complete");
	assert.equal(rehearsalStatus({ status: "complete", bindings }, { ...bindings, snapshot: "block-2" }), "outdated");
	assert.equal(upgradeCompletionStatus({ executionVerified: true, serviceRestored: true, publicationVerified: false }), "publication-pending");
});

test("publication retry skips completed items and rejects changed item intent", async () => {
	const progress = {},
		published = [],
		items = [
			{ id: "facet-a", codeHash: "a" },
			{ id: "facet-b", codeHash: "b" },
		];
	let fail = true;
	const publish = async item => {
		if (item.id === "facet-b" && fail) throw new Error("Explorer unavailable");
		published.push(item.id);
	};
	await assert.rejects(
		publishUpgradeItems(items, progress, () => {}, publish),
		/Explorer unavailable/,
	);
	assert.deepEqual(published, ["facet-a"]);
	fail = false;
	await publishUpgradeItems(items, progress, () => {}, publish);
	assert.deepEqual(published, ["facet-a", "facet-b"]);
	await assert.rejects(
		publishUpgradeItems([{ ...items[0], codeHash: "changed" }], progress, () => {}, publish),
		/changed/,
	);
});

test("standard runner verifies live service and retries publication without pause or repeated execution", async t => {
	const f = await coreUpgradeFixture(t),
		definition = TASK_DEFINITIONS.find(task => task.id === "maintenance.core-upgrade");
	const phases = [];
	const governanceKeys = [];
	let failPublication = true;
	let failMuonReadiness = true;
	const run = (ctx, input) =>
		definition.run(
			{
				...ctx,
				runProcess: async (_command, args, options) => {
					const phase = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : "compile";
					phases.push(phase);
					const report = read(input.output);
					if (phase === "inspect") {
						report.initial = { blockNumber: 100 };
						report.client = { changes: [], abiDigest: digest([]) };
						write(path.join(path.dirname(input.output), "core-abi.json"), []);
					}
					if (phase === "deploy") report.deployments = { facets: {} };
					if (phase.startsWith("plan-"))
						report[phase === "plan-cut" ? "batch" : `${phase.slice(5)}Batch`] = {
							actions: [{ to: f.config.target.core, value: "0", data: "0x12345678", description: "Reviewed operation" }],
							envelope: {},
						};
					if (phase === "plan-cut") report.cutSnapshot = { blockNumber: 200, pause: [false] };
					if (phase === "execute-governance") {
						const key = options.env.SYMMIO_CORE_UPGRADE_BATCH;
						governanceKeys.push(key);
						report.governanceExecutions ||= {};
						report.governanceExecutions[key] = { receipts: "[]" };
					}
					if (phase === "verify-cut") report.verifiedCut = { success: true };
					if (phase === "verify-muon") {
						assert.ok(ctx.state.completedSteps.includes("cut"));
						assert.equal(ctx.state.completedSteps.includes("unpause"), false);
						if (failMuonReadiness) throw new Error("Muon readiness RPC unavailable");
						report.muonReadiness = { canaries: "verified" };
					}
					if (phase === "verify-service") {
						report.verifiedService = { cutDigest: ctx.state.coreEvidence.verifiedCut };
						report.status = "publication-pending";
					}
					if (phase === "publish") {
						assert.ok(ctx.state.completedSteps.includes("verify-service"));
						if (failPublication) throw new Error("Explorer unavailable");
						report.publication = { complete: true };
						report.status = "complete";
					}
					write(input.output, report);
				},
			},
			input,
		);
	const task = { ...definition, run, handler: run },
		runner = createTaskRunner({ root: f.root, definitions: [task] });
	const notes = [];
	const ui = {
		note: (message, title) => notes.push({ message, title }),
		confirm: async () => true,
		text: async () => String(f.config.network.chainId),
	};
	let state = await runner.start(task.id, { input: f.input, ui });
	assert.equal(state.status, "paused", state.lastError);
	assert.match(state.lastError, /Muon readiness RPC unavailable/);
	const review = notes.find(note => note.title === "Deployment authorization").message;
	for (const category of [
		"storage.symbolAdjustment",
		"funding.aggregate",
		"selectors.core",
		"roleGrants.core",
		"limits.coreSnapshot",
		"limits.signatureVerifierSnapshot",
		"governance.accountLayerOwner",
		"target.symbolManager",
		"credentials.deployer",
	])
		assert.ok(review.includes(category));
	assert.ok(review.includes(`Core (${f.config.target.core})`));
	assert.ok(review.includes(f.config.target.symbolManager));
	assert.ok(review.includes(f.config.governance.owner));
	assert.equal(phases.includes("plan-unpause"), false);
	assert.equal(phases.includes("publish"), false);
	failMuonReadiness = false;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "paused", state.lastError);
	assert.match(state.lastError, /Explorer unavailable/);
	assert.equal(read(f.input.output).status, "publication-pending");
	failPublication = false;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "completed", state.lastError);
	assert.equal(phases.filter(phase => phase === "deploy").length, 1);
	assert.equal(phases.filter(phase => phase === "verify-cut").length, 1);
	assert.equal(phases.filter(phase => phase === "verify-service").length, 1);
	assert.deepEqual(governanceKeys, ["cut"]);
	assert.equal(
		phases.some(phase => /pause/.test(phase)),
		false,
	);
	assert.equal(
		phases.some(phase => phase.startsWith("rehearse-")),
		false,
	);
});

test("standalone rehearsal is registered without a live transaction signer", () => {
	const task = TASK_DEFINITIONS.find(task => task.id === "maintenance.core-upgrade-rehearse");
	assert.ok(task);
	assert.equal(task.risk, "local-write");
	assert.equal(
		task.inputs.some(input => input.id === "signer"),
		false,
	);
	assert.deepEqual(
		task.plan().map(step => step.id),
		["compile", "inspect", "rehearse-initial"],
	);
});
