import { CORE_UPGRADE_API, CUT_SELECTOR, digest, planCoreCut, validateCoreUpgradeConfig } from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { loadRecipeContext } from "../lib/recipe-context.js";
import { SIGNER_MODES } from "../signer/index.js";
import { createTaskRunner } from "../task-runner.js";
import { CORE_UPGRADE_PLAN, coreUpgradeEnvironment, validateCoreTaskInput } from "../tasks/arbitrum-core-upgrade.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { Interface, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const definition = TASK_DEFINITIONS.find(t => t.id === "maintenance.arbitrum-core-upgrade");
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const address = n => "0x" + n.toString(16).padStart(40, "0");

test("current Core task has strict journal/recovery policies and two mandatory rehearsals", () => {
	assert.equal(definition.handler, definition.run);
	assert.equal(definition.transactionJournal, true);
	assert.deepEqual(definition.resumePolicy, { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" });
	assert.deepEqual(definition.plan(), CORE_UPGRADE_PLAN);
	const steps = definition.plan().map(s => s.id);
	assert.ok(steps.indexOf("rehearse-initial") < steps.indexOf("deploy"));
	assert.ok(steps.indexOf("pause") < steps.indexOf("plan-cut"));
	assert.ok(steps.indexOf("rehearse-cut") < steps.indexOf("cut"));
	assert.ok(steps.indexOf("cut") < steps.indexOf("unpause"));
	assert.equal(new Set(steps).size, steps.length);
});

test("Core profile selects the current deployment and refuses a different Core, Safe, scope or incomplete scan", () => {
	const config = read("tasks/config/arbitrum-core-upgrade-42161.json");
	assert.equal(validateCoreUpgradeConfig(config).target.instantLayer.toLowerCase(), "0x38aabc7a73523cd47c710fcdeb3b20ae02310180");
	for (const mutate of [
		c => (c.target.core = address(1)),
		c => (c.target.safe = address(2)),
		c => (c.chainId = 1),
		c => (c.limits.maxQuotes = 0),
		c => c.allowedRemovedSelectors.push("0x12345678"),
		c => (c.repairAggregateFunding = false),
	]) {
		const changed = structuredClone(config);
		mutate(changed);
		assert.throws(() => validateCoreUpgradeConfig(changed));
	}
});

test("one atomic cut preserves diamondCut, rejects unknown removals/duplicates/partial execution and is idempotent", () => {
	const baseline = { [CUT_SELECTOR]: address(1), "0x12345678": address(2), "0x9dcdbdda": address(3) };
	const facets = { current: { address: address(4), selectors: ["0x12345678", "0x87654321"] } };
	const result = planCoreCut(baseline, baseline, facets, ["0x9dcdbdda"]);
	const iface = new Interface(["function diamondCut((address,uint8,bytes4[])[],address,bytes)"]);
	const decoded = iface.decodeFunctionData("diamondCut", result.calldata);
	assert.equal(decoded[1], ZeroAddress);
	assert.equal(decoded[2], "0x");
	assert.equal(result.desired[CUT_SELECTOR], baseline[CUT_SELECTOR]);
	assert.deepEqual(result.cut.map(c => c.action).sort(), [0, 1, 2]);
	assert.equal(planCoreCut(baseline, result.desired, facets, ["0x9dcdbdda"]).calldata, null);
	assert.throws(() => planCoreCut(baseline, baseline, facets, []), /Unreviewed/);
	assert.throws(() => planCoreCut(baseline, { ...baseline, "0x12345678": address(4) }, facets, ["0x9dcdbdda"]), /atomic cut/);
	assert.throws(() => planCoreCut(baseline, baseline, { ...facets, duplicate: facets.current }, []), /Duplicate/);
	assert.throws(() => planCoreCut(baseline, baseline, { current: { address: address(4), selectors: [CUT_SELECTOR] } }, []), /reserved/);
});

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-core-upgrade-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "cli"));
	fs.writeFileSync(path.join(root, "cli/source.js"), "// pinned fixture\n");
	const config = path.join(root, "recipe.json"),
		forkConfig = path.join(root, "fork-recipe.json");
	const recipe = read("deployment-recipes/arbitrum-vibe-production.json");
	write(config, recipe);
	write(forkConfig, { ...recipe, network: { name: "fork-arbitrum", chainId: 42161, mode: "fork" } });
	const standard = {
		apiVersion: CORE_UPGRADE_API,
		config: read("tasks/config/arbitrum-core-upgrade-42161.json"),
		sourceCommit: "a".repeat(40),
		recipeDigest: loadRecipeContext(config, { plan: false }).digest,
		forkRecipeDigest: loadRecipeContext(forkConfig, { plan: false }).digest,
	};
	const input = {
		network: "arbitrum",
		chainId: 42161,
		mode: "live",
		config,
		forkConfig,
		sourceCommit: standard.sourceCommit,
		inputDigest: digest(standard),
		input: path.join(root, "input.json"),
		output: path.join(root, "report.json"),
		signer: { mode: SIGNER_MODES.KEYSTORE, key: "DEPLOYMENT_TEST" },
	};
	write(input.input, standard);
	write(input.output, { inputDigest: input.inputDigest, transactions: [] });
	return { root, standard, input };
}

test("input, recipes, snapshot and ABI bindings fail closed; direct adapters default to nonexecution", t => {
	const f = fixture(t),
		ctx = { state: {} };
	assert.doesNotThrow(() => validateCoreTaskInput(ctx, f.input));
	assert.equal(coreUpgradeEnvironment(f.input).SYMMIO_CORE_UPGRADE_EXECUTE, "false");
	assert.equal(coreUpgradeEnvironment(f.input).CONFIRM_CHAIN_ID, "");
	assert.equal(coreUpgradeEnvironment(f.input, {}, true).SYMMIO_DEPLOYMENT_RECIPE, f.input.forkConfig);
	const report = read(f.input.output);
	report.initial = { blockNumber: 100, pause: false };
	ctx.state.coreEvidence = { initial: digest(report.initial) };
	write(f.input.output, report);
	report.initial.pause = true;
	write(f.input.output, report);
	assert.throws(() => validateCoreTaskInput(ctx, f.input), /initial evidence changed/);
});

test("real runner waits for Safe execution, resumes without duplicate deployments and binds all rehearsals", async t => {
	const f = fixture(t),
		phases = [],
		receipts = {},
		flags = { ready: false };
	const action = { to: f.standard.config.target.core, value: "0", data: "0x12345678", description: "Reviewed Core operation" };
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
						report.client = { changes: ["ABI update"], abiDigest: digest([]) };
						write(path.join(f.root, "core-abi.json"), []);
					}
					if (phase === "rehearse-initial") report.initialRehearsal = { initialDigest: digest(report.initial), status: "complete" };
					if (phase === "deploy") {
						assert.equal(options.env.CONFIRM_CHAIN_ID, "42161");
						assert.equal(options.env.SYMMIO_CORE_UPGRADE_EXECUTE, "true");
						report.deployments = { facets: {} };
					}
					if (phase === "publish") {
						assert.equal(options.env.SYMMIO_RECIPE_READ_ONLY, "false");
						report.publication = { complete: true };
					}
					if (phase.startsWith("plan-")) {
						const key = phase.slice(5);
						report[key === "cut" ? "batch" : `${key}Batch`] = { actions: [action], envelope: { safeTxHash: "0x" + "1".repeat(64) } };
					}
					if (phase === "verify-pause") report.paused = { blockNumber: 200 };
					if (phase === "rehearse-cut") report.cutRehearsal = { batchDigest: digest(report.batch) };
					if (phase.startsWith("rehearse-")) {
						assert.equal(options.env.SYMMIO_SIGNER_MODE, "local-node");
						assert.equal(options.env.FORK_BLOCK_NUMBER, phase.endsWith("initial") ? "100" : "200");
					}
					if (phase === "check-export" && options.env.SYMMIO_CORE_UPGRADE_BATCH === "cut") assert.ok(ctx.state.coreEvidence.cutRehearsal);
					if (phase.startsWith("verify-")) assert.equal(options.env.SYMMIO_CORE_UPGRADE_RECEIPT, receipts[phase.slice(7)]);
					if (phase === "verify-cut") report.verifiedCut = { success: true };
					if (phase === "verify-unpause") report.status = "complete";
					write(input.output, report);
				},
			},
			input,
		);
	const task = { ...definition, run, handler: run },
		runner = createTaskRunner({ root: f.root, definitions: [task], idFactory: () => "core-upgrade-test" });
	const ui = {
		note() {},
		confirm: async ({ message }) => (message.startsWith("Have client") ? flags.ready : true),
		text: async ({ message }) => (message.startsWith("Type 42161") ? "42161" : receipts[message.split(" ")[1]] || ""),
	};
	const runtime = { ui };
	let state = await runner.start(task.id, { ...runtime, input: f.input });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.match(state.waitingFor, /ABI consumers/);
	flags.ready = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.ok(state.safeDispatches.pause);
	const digestBefore = state.safeDispatches.pause.digest;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external");
	assert.equal(state.safeDispatches.pause.digest, digestBefore);
	assert.equal(phases.includes("verify-pause"), false);
	receipts.pause = "0x" + "a".repeat(64);
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.ok(state.safeDispatches.cut);
	assert.ok(state.completedSteps.includes("rehearse-cut"));
	receipts.cut = "0x" + "b".repeat(64);
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.ok(state.safeDispatches.unpause);
	receipts.unpause = "0x" + "c".repeat(64);
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "completed", state.lastError);
	assert.equal(read(f.input.output).status, "complete");
	assert.equal(phases.filter(p => p === "deploy").length, 1);
	assert.equal(phases.filter(p => p === "rehearse-cut").length, 1);
});
