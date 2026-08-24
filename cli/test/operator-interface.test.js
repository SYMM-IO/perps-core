import { activeDescription, homeOptions, taskSummary } from "../app.js";
import { readDeploymentReport } from "../lib/context.js";
import { HELP_TEXT, runCli } from "../symmio.js";
import { catalog } from "../task-runner.js";
import { TASK_DEFINITIONS, checklistExplorerVerification } from "../tasks/registry.js";
import assert from "node:assert/strict";
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

test("completed deployment reports are described as history, not active task state", () => {
	const arbitrumReport = readDeploymentReport(42161);
	assert.equal(arbitrumReport.lifecycle, "complete");
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
	assert.equal(entries.filter(item => item.category === "maintenance").length, 11);
	const settlementRepair = entries.find(item => item.id === "maintenance.recreate-settlement-templates");
	assert.equal(settlementRepair.title, "Recreate settleUpnl InstantLayer templates");
	assert.deepEqual(settlementRepair.supportedNetworks, ["localhost", "fork-arbitrum", "arbitrum"]);
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

test("full deployment plans give every contract batch entry a unique stable id", async () => {
	const definition = TASK_DEFINITIONS.find(item => item.id === "deploy.full");
	for (const mode of ["local", "fork", "live"]) {
		const plan = await definition.plan({}, { mode });
		const items = plan.flatMap(step => step.items || []);
		assert.ok(items.length > 0);
		assert.equal(new Set(items).size, items.length);
		for (const item of items) assert.match(item, /^[a-z0-9][a-z0-9.-]*$/);
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
