import { digest, UPGRADE_DEPLOYMENTS } from "../../deployment-tooling/account-instant-upgrade.js";
import { loadRecipeContext } from "../lib/recipe-context.js";
import { SIGNER_MODES } from "../signer/index.js";
import { createTaskRunner } from "../task-runner.js";
import {
	ACCOUNT_INSTANT_PLAN,
	accountInstantEnvironment,
	reviewedConfiguration,
	validateAccountInstantInput,
} from "../tasks/account-instant-upgrade.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const definition = TASK_DEFINITIONS.find(task => task.id === "maintenance.arbitrum-account-instant-upgrade");
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const read = file => JSON.parse(fs.readFileSync(file));
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-account-instant-"));
	fs.mkdirSync(path.join(root, "cli"));
	fs.writeFileSync(path.join(root, "cli/source.js"), "// pinned test source\n");
	const directory = path.join(root, "tasks/data/42161/upgrade");
	fs.mkdirSync(directory, { recursive: true });
	const recipe = read("deployment-recipes/arbitrum-vibe-production.json");
	const config = path.join(directory, "recipe.json"),
		forkConfig = path.join(directory, "fork-recipe.json");
	write(config, recipe);
	write(forkConfig, { ...recipe, network: { name: "fork-arbitrum", chainId: 42161, mode: "fork" } });
	const standard = {
		config: read("tasks/config/arbitrum-account-instant-upgrade-42161.json"),
		sourceCommit: "a".repeat(40),
		recipeDigest: loadRecipeContext(config, { plan: false }).digest,
		forkRecipeDigest: loadRecipeContext(forkConfig, { plan: false }).digest,
	};
	const input = {
		config,
		forkConfig,
		input: path.join(directory, "input.json"),
		output: path.join(directory, "report.json"),
		inputDigest: digest(standard),
		sourceCommit: standard.sourceCommit,
		network: "arbitrum",
		mode: "live",
		chainId: 42161,
		signer: { mode: SIGNER_MODES.KEYSTORE, key: "DEPLOYMENT_TEST" },
	};
	write(input.input, standard);
	write(input.output, { inputDigest: input.inputDigest, transactions: [] });
	const snapshot = {
		blockNumber: 1234,
		gasless: { fees: { defaultSelectorFee: "0" }, roles: [] },
		instant: { templates: [] },
		partyBAdmins: standard.config.target.partyBAdmins,
	};
	return { root, directory, input, snapshot, standard };
}

test("account/instant task has the exact ordered deployment scope and strict recovery policies", () => {
	assert.equal(definition.handler, definition.run);
	assert.deepEqual(definition.resumePolicy, { strategy: "stable-step-id", sourceDrift: "refuse", inputDrift: "refuse" });
	assert.equal(definition.transactionJournal, true);
	assert.deepEqual(
		definition.plan().find(step => step.id === "deploy").items,
		UPGRADE_DEPLOYMENTS.map(name => name.toLowerCase()),
	);
	assert.equal(UPGRADE_DEPLOYMENTS.length, 8);
	assert.deepEqual(
		definition.plan().map(step => step.id),
		ACCOUNT_INSTANT_PLAN.map(step => step.id),
	);
	assert.ok(ACCOUNT_INSTANT_PLAN.findIndex(s => s.id === "deploy") < ACCOUNT_INSTANT_PLAN.findIndex(s => s.id === "account-cut"));
});

test("current-value input and credential recipe changes fail closed, including false/zero changes", t => {
	const f = fixture();
	t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	assert.doesNotThrow(() => validateAccountInstantInput(f.input));
	const report = read(f.input.output);
	report.snapshotDigest = digest(f.snapshot);
	write(f.input.output, report);
	write(path.join(f.directory, "configuration-input.json"), f.snapshot);
	const ctx = { state: { configurationDigest: report.snapshotDigest } };
	assert.deepEqual(reviewedConfiguration(ctx, f.input), f.snapshot);
	f.snapshot.gasless.fees.defaultSelectorFee = "1";
	write(path.join(f.directory, "configuration-input.json"), f.snapshot);
	assert.throws(() => reviewedConfiguration(ctx, f.input), /Reviewed configuration input changed/);
	const recipe = read(f.input.config);
	recipe.name += "-changed";
	write(f.input.config, recipe);
	assert.throws(() => validateAccountInstantInput(f.input), /credential recipe changed/);
});

test("adapter environment defaults to nonexecution and uses the same credential recipe projected onto a fork", t => {
	const f = fixture();
	t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const env = accountInstantEnvironment(f.input);
	assert.equal(env.SYMMIO_ACCOUNT_UPGRADE_EXECUTE, "false");
	assert.equal(env.CONFIRM_CHAIN_ID, "");
	assert.equal(env.DOTENV_CONFIG_PATH, "/dev/null");
	assert.equal(accountInstantEnvironment(f.input, {}, true).SYMMIO_DEPLOYMENT_RECIPE, f.input.forkConfig);
	assert.equal(read(f.input.config).secrets.rpc, read(f.input.forkConfig).secrets.rpc);
});

test("runner defers PartyB calls to manual execution and verifies them before cutover and completion", async t => {
	const f = fixture();
	t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const flags = { configured: false, cut: false, wired: false, retired: false, partyB: false, partyBRetired: false, canary: "" };
	const phases = [],
		events = [];
	const admin = Object.values(f.standard.config.target.partyBAdmins)[0].toLowerCase();
	const safe = f.standard.config.target.safe.toLowerCase();
	const action = authority => ({
		authority,
		to: f.standard.config.target.accountLayer,
		value: "0",
		data: "0x12345678",
		description: "Reviewed upgrade action",
	});
	const run = async (ctx, input) =>
		definition.run(
			{
				...ctx,
				runProcess: async (_command, args, options) => {
					const phase = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : "compile";
					phases.push(phase);
					const report = read(input.output);
					if (phase === "inspect") {
						write(path.join(f.directory, "configuration-input.json"), f.snapshot);
						report.snapshotDigest = digest(f.snapshot);
						report.snapshotBlock = f.snapshot.blockNumber;
					}
					if (phase === "rehearse") {
						assert.equal(options.env.FORK_BLOCK_NUMBER, "1234");
						assert.equal(options.env.SYMMIO_SIGNER_MODE, "local-node");
						assert.equal(options.env.SYMMIO_DEPLOYMENT_RECIPE, input.forkConfig);
						report.rehearsal = { status: "complete", snapshotDigest: digest(f.snapshot) };
					}
					assert.equal(phase.startsWith("execute-"), false, "PartyB execution must remain external");
					if (phase === "deploy") {
						assert.equal(options.env.SYMMIO_ACCOUNT_UPGRADE_EXECUTE, "true");
						assert.equal(options.env.CONFIRM_CHAIN_ID, "42161");
					}
					if (phase === "plan-configure-instant") report.actions = flags.configured ? [] : [action(safe)];
					if (phase === "plan-account-cut") report.actions = flags.cut ? [] : [action(safe)];
					if (phase === "plan-wire") report.actions = flags.wired ? [] : [action(safe)];
					if (phase === "plan-retire") report.actions = flags.retired ? [] : [action(safe)];
					if (phase === "plan-party-b") report.actions = flags.partyB ? [] : [action(admin)];
					if (phase === "plan-retire-party-b") report.actions = flags.partyBRetired ? [] : [action(admin)];
					if (["plan-party-b", "plan-retire-party-b"].includes(phase)) {
						assert.equal(options.env.SYMMIO_ACCOUNT_UPGRADE_EXECUTE, "false");
						assert.equal(options.env.SYMMIO_RECIPE_READ_ONLY, "true");
						assert.equal(options.env.SYMMIO_SIGNER_MODE, "safe-file");
					}
					if (phase === "canary") report.canary = { hash: options.env.SYMMIO_ACCOUNT_UPGRADE_CANARY };
					if (phase === "verify-final") {
						report.status = "complete";
						report.verifiedBlock = 1300;
					}
					write(input.output, report);
				},
			},
			input,
		);
	const task = { ...definition, run, handler: run };
	const runner = createTaskRunner({ root: f.root, definitions: [task], idFactory: () => "account-upgrade-run" });
	const ui = {
		note() {},
		confirm: async () => true,
		select: async () => assert.fail("No PartyB signer should be requested"),
		text: async ({ message }) => {
			assert.doesNotMatch(message, /Ledger address|PartyB administrator/);
			return message.includes("Type 42161") ? "42161" : flags.canary;
		},
	};
	const runtime = { ui, onEvent: e => events.push(e) };
	let state = await runner.start(task.id, { ...runtime, input: f.input });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(state.completedSteps.includes("account-cut"), false);
	assert.match(state.waitingFor, /Execute .* through Safe/);
	assert.equal(phases.filter(p => p === "deploy").length, 1);
	flags.cut = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(flags.partyB, false);
	assert.match(state.waitingFor, /Execute .* through Safe/);
	flags.configured = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(flags.partyB, false);
	assert.equal(state.completedSteps.includes("party-b"), false);
	assert.match(state.waitingFor, /Complete the PartyB actions manually/);
	assert.equal(phases.includes("plan-wire"), false);
	const manualFile = path.join(f.directory, "party-b-manual.json");
	assert.deepEqual(read(manualFile), {
		apiVersion: "operations.symm.io/manual-transactions-v1",
		chainId: 42161,
		inputDigest: f.input.inputDigest,
		snapshotDigest: digest(f.snapshot),
		stage: "party-b",
		status: "pending",
		transactions: [{ from: admin, to: action(admin).to, value: "0", data: "0x12345678", description: action(admin).description }],
	});
	write(manualFile, { ...read(manualFile), status: "verified", transactions: [] });
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(state.completedSteps.includes("party-b"), false, "continuing is not proof of manual execution");
	assert.equal(read(manualFile).status, "pending", "editing the manual file cannot bypass on-chain verification");
	assert.equal(phases.includes("plan-wire"), false);
	flags.partyB = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.match(state.waitingFor, /Execute .* through Safe/);
	assert.equal(read(manualFile).status, "verified");
	assert.deepEqual(read(manualFile).transactions, []);
	assert.equal(
		Object.keys(state.signing || {}).some(key => key.startsWith("party-b-")),
		false,
	);
	flags.wired = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.match(state.waitingFor, /real delegation grant/);
	assert.equal(phases.includes("plan-retire"), false);
	flags.canary = `0x${"1".repeat(64)}`;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	flags.retired = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(flags.partyBRetired, false);
	assert.equal(phases.includes("verify-final"), false);
	assert.match(state.waitingFor, /Complete the PartyB actions manually/);
	const retirementFile = path.join(f.directory, "retire-party-b-manual.json");
	assert.equal(read(retirementFile).stage, "retire-party-b");
	assert.equal(read(retirementFile).transactions[0].from, admin);
	flags.partyBRetired = true;
	state = await runner.resumeActive(runtime);
	assert.equal(state.status, "completed", state.lastError);
	assert.equal(read(retirementFile).status, "verified");
	assert.equal(phases.filter(p => p === "deploy").length, 1);
	assert.equal(events.filter(e => e.type === "safe.exported").length, 4);
	assert.equal(state.transactions.length, 0, "fork rehearsal transactions must not enter the live journal");
});
