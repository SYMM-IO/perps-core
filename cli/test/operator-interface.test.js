import { activeDescription, homeOptions, taskSummary } from "../app.js";
import { HELP_TEXT, runCli } from "../symmio.js";
import { catalog } from "../task-runner.js";
import { TASK_DEFINITIONS, checklistExplorerVerification } from "../tasks/registry.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function stream({ tty = false } = {}) {
	let value = "";
	return { isTTY: tty, write: chunk => (value += chunk), value: () => value };
}

test("the public entrypoint is menu-only and help only explains how to launch it", async () => {
	const stdout = stream();
	const stderr = stream();
	assert.equal(await runCli(["--help"], { stdout, stderr, stdin: stream() }), 0);
	assert.equal(stdout.value(), HELP_TEXT);
	assert.doesNotMatch(stdout.value(), /doctor --|deploy --|status --/);

	const rejected = stream();
	assert.equal(await runCli(["deploy", "--network", "arbitrum"], { stdout: stream(), stderr: rejected, stdin: stream() }), 2);
	assert.match(rejected.value(), /menu-only/);
});

test("non-TTY execution fails clearly instead of falling back to commands", async () => {
	const stderr = stream();
	assert.equal(await runCli([], { stdin: stream(), stdout: stream(), stderr }), 2);
	assert.match(stderr.value(), /interactive terminal \(TTY\)/);
});

test("home menu ordering is exact and active actions stay visibly disabled", () => {
	const empty = homeOptions(null);
	assert.deepEqual(
		empty.map(option => option.label),
		[
			"Deploy a contract",
			"Patch configurations for deployed contracts",
			"Run the checklist on a new deployment",
			"Other maintenance scripts",
			"Continue active task",
			"Cancel active task",
			"Exit",
		],
	);
	assert.equal(empty[4].disabled, true);
	assert.equal(empty[5].disabled, true);
	const active = homeOptions({ status: "paused", title: "Full system" });
	assert.equal(active[4].disabled, false);
	assert.equal(active[5].disabled, false);
});

test("idle state describes deployment reports as history, not active task state", () => {
	assert.match(activeDescription(null), /No active task/);
	assert.match(activeDescription(null), /Completed deployment reports remain in history/);
});

test("catalog is explicit, complete, and hides deployment primitives", () => {
	const entries = catalog();
	assert.deepEqual(
		entries.filter(item => item.category === "deploy").map(item => item.title),
		[
			"Full SYMMIO system",
			"Core bundle",
			"PartyB",
			"SymbolManager",
			"ExpressProvider",
			"GaslessLayer",
			"SymmioLiquidator",
			"FeeDistributor",
			"MultiAccount",
			"Multicall",
		],
	);
	assert.equal(entries.filter(item => item.category === "patch").length, 1);
	assert.equal(entries.filter(item => item.category === "checklist").length, 1);
	assert.equal(entries.filter(item => item.category === "maintenance").length, 12);
	const arbitrumUpgrade = entries.find(item => item.id === "maintenance.arbitrum-perps-upgrade");
	assert.equal(arbitrumUpgrade.title, "Arbitrum Perps Core v0.8.6 upgrade");
	assert.deepEqual(arbitrumUpgrade.supportedNetworks, ["arbitrum"]);
	assert.equal(arbitrumUpgrade.risk, "transaction");
	assert.deepEqual(
		TASK_DEFINITIONS.find(item => item.id === "maintenance.arbitrum-perps-upgrade")
			.plan()
			.map(step => step.id),
		[
			"compile",
			"inspect",
			"rehearse",
			"authorize",
			"deploy-core-facets",
			"deploy-account-facets",
			"deploy-instant-layer",
			"deploy-gasless-layer",
			"publish",
			"plan-governance",
			"core-cut",
			"verify-core-cut",
			"account-cut",
			"verify-account-cut",
			"account-authority",
			"core-authority",
			"verify-authority",
			"wiring",
			"verify-wiring",
			"canary",
			"cutover",
			"verify-cutover",
			"safe-hardening",
			"final-report",
		],
	);
	const settlementRepair = entries.find(item => item.id === "maintenance.recreate-settlement-templates");
	assert.equal(settlementRepair.title, "Recreate settleUpnl InstantLayer templates");
	assert.deepEqual(settlementRepair.supportedNetworks, ["localhost", "fork-arbitrum", "arbitrum"]);
	const symbolFetch = entries.find(item => item.id === "maintenance.symbol-sync-fetch");
	const symbolAssign = entries.find(item => item.id === "maintenance.symbol-sync-assign");
	assert.equal(symbolFetch.risk, "local-write");
	assert.equal(symbolAssign.risk, "transaction");
	assert.deepEqual(symbolAssign.supportedNetworks, ["arbitrum"]);
	assert.deepEqual(
		TASK_DEFINITIONS.find(item => item.id === "maintenance.symbol-sync-assign")
			.plan()
			.map(step => step.id),
		["inspect", "authorize", "apply", "verify"],
	);
	for (const removed of ["maintenance.rpc-health", "maintenance.arbitrum-ledger-handover"]) {
		assert.ok(!entries.some(entry => entry.id === removed));
	}
	for (const hidden of ["Create2Factory", "FakeStablecoin", "Diamond", "AccountLayer", "InstantLayer", "MuonSignatureVerifier"]) {
		assert.ok(!entries.some(entry => entry.title === hidden));
	}
	assert.ok(entries.find(entry => entry.id === "deploy.symmio-liquidator").supportedNetworks.includes("localhost"));
});

test("the deployment checklist requires explorer success live and an explicit not-applicable result locally", () => {
	const context = mode => ({ recipe: { network: { mode } } });
	assert.equal(checklistExplorerVerification(context("live"), { checks: { verificationPolicy: "required", verification: "passed" } }), true);
	assert.equal(checklistExplorerVerification(context("live"), { checks: { verificationPolicy: "required", verification: "skipped" } }), false);
	assert.equal(
		checklistExplorerVerification(context("local"), { checks: { verificationPolicy: "not_applicable", verification: "skipped" } }),
		true,
	);
	assert.equal(checklistExplorerVerification(context("local"), { checks: { verificationPolicy: "required", verification: "passed" } }), false);
});

test("operator docs explain classified governance handover and the readable report", () => {
	const documentation = ["cli/README.md", "docs/deployment.md", "docs/deployment-guide.html"]
		.map(file => fs.readFileSync(path.resolve(file), "utf8"))
		.join("\n");
	for (const phrase of [
		"Ledger hardware wallet",
		"Hardhat keystore wallet",
		"Safe Transaction Builder",
		"deployment-summary.md",
		"Handover required",
	]) {
		assert.match(documentation, new RegExp(phrase, "i"));
	}
	assert.match(documentation, /tasks\/data\/.*ignored.*local evidence/is);
});

test("full deployment plans give every contract batch entry a unique stable id", async () => {
	const definition = TASK_DEFINITIONS.find(item => item.id === "deploy.full");
	assert.equal(definition.version, 4);
	for (const mode of ["local", "fork", "live"]) {
		const plan = await definition.plan({}, { mode });
		const items = plan.flatMap(step => step.items || []);
		assert.ok(items.length > 0);
		assert.equal(new Set(items).size, items.length);
		for (const item of items) assert.match(item, /^[a-z0-9][a-z0-9.-]*$/);
	}
	const productionPlan = await definition.plan({}, { mode: "live", config: path.resolve("deployment-recipes/arbitrum-vibe-production.json") });
	for (const step of productionPlan.filter(step => step.items)) {
		assert.equal(new Set(step.items).size, step.items.length);
		for (const item of step.items) assert.match(item, /^[a-z0-9][a-z0-9.-]*$/);
	}
	const liveItems = productionPlan.find(step => step.id === "execute").items;
	assert.ok(liveItems.some(item => item.startsWith("live.party-b.grant-trusted-operator-")));
	assert.ok(liveItems.includes("live.liquidator.deploy-proxy"));
	assert.ok(liveItems.some(item => item.startsWith("live.liquidator.grant-operator-")));
	assert.ok(liveItems.includes("live.liquidator.grant-core-liquidator-role"));
	assert.ok(liveItems.includes("live.liquidator.grant-core-partyb-liquidator-role"));
});

test("standalone deployments expose stable preflight, execution, and post-state verification steps", async () => {
	const cases = [
		{
			id: "deploy.fee-distributor",
			input: {
				network: "fork-arbitrum",
				symmio: "0x1111111111111111111111111111111111111111",
				admin: "0x2222222222222222222222222222222222222222",
				receiver: "0x3333333333333333333333333333333333333333",
				share: "400000000000000000",
			},
		},
		{
			id: "deploy.multi-account",
			input: {
				network: "fork-arbitrum",
				symmio: "0x1111111111111111111111111111111111111111",
				admin: "0x2222222222222222222222222222222222222222",
			},
		},
		{ id: "deploy.multicall", input: { network: "fork-arbitrum" } },
	];

	for (const testCase of cases) {
		const definition = TASK_DEFINITIONS.find(item => item.id === testCase.id);
		assert.equal(definition.version, 3);
		assert.deepEqual(
			(await definition.plan({}, testCase.input)).map(step => [step.id, step.phase]),
			[
				["inspect", "prepare"],
				["deploy", "execution"],
				["verify", "verification"],
			],
		);

		const steps = [];
		const processes = [];
		await definition.run(
			{
				step: async (id, title, action) => {
					steps.push([id, title]);
					return action();
				},
				runProcess: async (command, args) => processes.push([command, args]),
			},
			testCase.input,
		);
		assert.deepEqual(
			steps.map(([id]) => id),
			["inspect", "deploy", "verify"],
		);
		assert.equal(processes.length, 3);
		assert.ok(processes[0][1].includes("preflight"));
		assert.ok(processes[1][1][0].startsWith("deploy:"));
		assert.ok(processes[2][1].includes("poststate"));
	}
});

test("progress summary is compact at 80 columns and details expose hashes, receipts and gas", () => {
	const state = {
		completedSteps: ["one"],
		plan: [
			{ id: "one", phase: "prepare" },
			{ id: "two", phase: "execution" },
		],
		warnings: [{ message: "review" }],
		transactions: [{ label: "setAdmin", hash: `0x${"a".repeat(64)}`, status: "confirmed", gasUsed: "42000" }],
	};
	const current = { phase: "execution", stepId: "two", title: "Set admin" };
	const activity = { at: Date.now(), text: "Waiting for transaction receipt", processRunning: false };
	const compact = taskSummary(state, current, Date.now(), false, [], activity);
	assert.match(compact, /Phase\s+execution/);
	assert.match(compact, /1\/2 completed • step 2 running/);
	assert.match(compact, /Status\s+.*Working/);
	assert.match(compact, /Activity\s+Waiting for transaction receipt/);
	assert.doesNotMatch(compact, /0xaaaa/);
	const detailed = taskSummary(state, current, Date.now(), true, ["receipt stored"], activity);
	assert.match(detailed, /0xaaaa/);
	assert.match(detailed, /gas 42000/);
	assert.match(detailed, /receipt stored/);
});

test("batch progress counts planned contracts, not transactions", () => {
	const plan = [
		{ id: "preflight", phase: "prepare" },
		{ id: "fork-rehearsal", phase: "rehearsal", items: ["fork.contract-001.a", "fork.contract-002.b"] },
		{ id: "execute", phase: "execution", items: ["live.contract-001.a", "live.contract-002.b"] },
	];
	// A deployment sends many more transactions than it creates contracts; transactions must
	// never move the batch portion of the bar.
	const chatty = {
		completedSteps: ["preflight"],
		plan,
		batchProgress: { "fork-rehearsal": ["A"] },
		transactions: Array.from({ length: 40 }, (_, index) => ({ hash: `0x${index}`, status: "confirmed" })),
	};
	const current = { phase: "rehearsal", stepId: "fork-rehearsal", title: "Execute the matching fork rehearsal" };
	const activity = { at: Date.now(), text: "working", processRunning: true };
	assert.match(taskSummary(chatty, current, Date.now(), false, [], activity), /2\/7 completed/);

	// The rehearsal cannot consume the live stage's budget, and extra contract events cap.
	const rehearsed = { ...chatty, batchProgress: { "fork-rehearsal": ["A", "B", "C"] } };
	assert.match(taskSummary(rehearsed, current, Date.now(), false, [], activity), /3\/7 completed/);

	// A completed step counts all of its items, so a resume that reuses contracts still finishes.
	const finished = {
		...chatty,
		completedSteps: ["preflight", "fork-rehearsal", "execute"],
		batchProgress: { "fork-rehearsal": ["A"] },
	};
	assert.match(taskSummary(finished, current, Date.now(), false, [], activity), /7\/7 completed/);
});

test("a deployment section is shown beside the phase instead of replacing the step title", () => {
	const state = { completedSteps: [], plan: [{ id: "execute", phase: "execution" }], transactions: [], warnings: [] };
	const current = { phase: "execution", stepId: "execute", title: "Execute and reconcile deployment", section: "Diamond Deployment" };
	const summary = taskSummary(state, current, Date.now(), false, [], { at: Date.now(), text: "working" });
	assert.match(summary, /Phase\s+execution › Diamond Deployment/);
	assert.match(summary, /Current\s+Execute and reconcile deployment/);
});
