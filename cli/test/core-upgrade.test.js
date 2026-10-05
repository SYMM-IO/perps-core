import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { createTaskRunner } from "../task-runner.js";
import { validateCoreTaskInput, coreUpgradeEnvironment } from "../tasks/arbitrum-core-upgrade.js";
import { prepareStandardCoreUpgrade } from "../tasks/core-upgrade.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const definition = TASK_DEFINITIONS.find(t => t.id === "maintenance.core-upgrade");
async function fixture(t, name = "arbitrum", kind = "eoa") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-standard-core-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const config = read("tasks/config/core-upgrade.arbitrum-vibe-production.input.json");
	config.network = { name, chainId: name === "base" ? 8453 : 42161, fork: `fork-${name}` };
	config.governance = {
		kind,
		owner: config.governance.owner,
		accountLayerOwner: config.governance.accountLayerOwner,
		signerMode: kind === "safe" ? "safe-file" : "hardhat-keystore",
		...(kind === "eoa" ? { signerKey: "GOVERNANCE_TEST" } : {}),
	};
	config.execution.slowNoticeSeconds = 7;
	fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
	fs.mkdirSync(path.join(root, "cli"));
	fs.mkdirSync(path.join(root, "tasks/config"), { recursive: true });
	fs.writeFileSync(path.join(root, "contracts/Release.sol"), "// source-bound fixture\n");
	fs.writeFileSync(path.join(root, "cli/source.js"), "// fixture\n");
	fs.writeFileSync(path.join(root, ".gitignore"), "tasks/data/\n.symmio/\n");
	const source = path.join(root, "tasks/config/core-upgrade.fixture.input.json");
	write(source, config);
	git(["init", "-q"]);
	git(["add", "contracts", "cli", "tasks/config", ".gitignore"]);
	git([
		"-c",
		"user.name=Upgrade Test",
		"-c",
		"user.email=upgrade@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"test: seed source",
	]);
	git(["tag", config.release.ref]);
	git(["tag", config.release.baselineRef]);
	const input = await prepareStandardCoreUpgrade({ root, ui: { select: async () => source, note() {} } });
	return { root, input, source, config, git };
}

test("standard task binds both Git refs and generates recipes from one input", async t => {
	const f = await fixture(t, "base");
	const bound = validateCoreTaskInput({ root: f.root, state: {} }, f.input);
	assert.equal(bound.baselineCommit, f.git(["rev-parse", "version_0.8.6.2"]));
	assert.equal(f.input.network, "base");
	assert.equal(coreUpgradeEnvironment(f.input).DEPLOY_SLOW_TX_NOTICE, "7");
	assert.equal(coreUpgradeEnvironment(f.input).SYMMIO_CORE_UPGRADE_EXECUTE, "false");
	assert.equal(read(f.input.forkConfig).network.name, "fork-base");
	assert.equal(definition.transactionJournal, true);
	assert.equal(definition.plan().filter(s => s.phase === "rehearsal").length, 2);
	assert.doesNotMatch(
		definition
			.plan()
			.map(s => s.title)
			.join(" "),
		/Safe/,
	);
	const original = fs.readFileSync(f.source);
	const changed = read(f.source);
	changed.limits.maxQuotes++;
	write(f.source, changed);
	assert.throws(() => validateCoreTaskInput({ root: f.root, state: {} }, f.input), /input changed/);
	fs.writeFileSync(f.source, original);
	f.git(["tag", "-d", "version_0.8.6.2"]);
	f.git([
		"-c",
		"user.name=Upgrade Test",
		"-c",
		"user.email=upgrade@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-qm",
		"test: change source",
	]);
	f.git(["tag", "version_0.8.6.2"]);
	f.git(["checkout", "--detach", "-q", bound.sourceCommit]);
	assert.throws(() => validateCoreTaskInput({ root: f.root, state: {} }, f.input), /baseline reference changed/);
	f.git(["checkout", "--detach", "-q", "version_0.8.6.2"]);
	assert.throws(() => validateCoreTaskInput({ root: f.root, state: {} }, f.input), /source changed/);
});

for (const network of ["arbitrum", "base"])
	for (const kind of ["safe", "eoa"]) {
		test(`${network} ${kind} runner binds forks, waits and resumes without repeating deployments`, async t => {
			const f = await fixture(t, network, kind),
				phases = [],
				receipts = {},
				flags = { owner: false, service: false };
			const action = { to: f.config.target.core, value: "0", data: "0x12345678", description: "Reviewed Core operation" };
			const run = (ctx, input) =>
				definition.run(
					{
						...ctx,
						runProcess: async (_command, args, options) => {
							const phase = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : "compile";
							phases.push(phase);
							const report = read(input.output);
							if (phase !== "compile") {
								assert.equal(args[0], "internal:core-upgrade");
								assert.equal(args.at(-1), phase.startsWith("rehearse-") ? `fork-${network}` : network);
							}
							if (phase === "inspect") {
								report.initial = { blockNumber: 100 };
								report.client = { changes: [], abiDigest: digest([]) };
								write(path.join(path.dirname(input.output), "core-abi.json"), []);
							}
							if (phase === "rehearse-initial") report.initialRehearsal = { status: "complete", initialDigest: digest(report.initial) };
							if (phase === "deploy") {
								assert.equal(options.env.CONFIRM_CHAIN_ID, String(f.config.network.chainId));
								report.deployments = { facets: {} };
							}
							if (phase === "publish") report.publication = { complete: true };
							if (phase.startsWith("plan-"))
								report[phase === "plan-cut" ? "batch" : `${phase.slice(5)}Batch`] = {
									actions: [action],
									envelope: { safeTxHash: "0x" + "1".repeat(64) },
								};
							if (phase === "rehearse-cut") report.cutRehearsal = { batchDigest: digest(report.batch) };
							if (phase.startsWith("rehearse-")) {
								assert.equal(options.env.FORK_BLOCK_NUMBER, phase.endsWith("initial") ? "100" : "200");
								assert.equal(options.env.SYMMIO_SIGNER_MODE, "local-node");
							}
							if (phase === "execute-governance") {
								const key = options.env.SYMMIO_CORE_UPGRADE_BATCH;
								assert.equal(options.env.CONFIRM_CHAIN_ID, String(f.config.network.chainId));
								assert.equal(options.env.SYMMIO_SIGNER_MODE, "hardhat-keystore");
								assert.equal(options.env.KEYSTORE_DEPLOYER_KEY, "GOVERNANCE_TEST");
								assert.equal(options.env.SYMMIO_EXPECTED_SIGNER, f.config.governance.owner);
								if (key === "cut") assert.ok(ctx.state.coreEvidence.cutRehearsal);
								report.governanceExecutions ||= {};
								report.governanceExecutions[key] = { receipts: JSON.stringify(["0x" + "a".repeat(64)]) };
							}
							if (phase === "verify-pause") report.paused = { blockNumber: 200 };
							if (phase === "verify-cut") report.verifiedCut = { success: true };
							if (phase === "verify-unpause") report.status = "complete";
							write(input.output, report);
						},
					},
					input,
				);
			const task = { ...definition, run, handler: run },
				runner = createTaskRunner({ root: f.root, definitions: [task], idFactory: () => "standard-core-test" });
			const ui = {
				note() {},
				confirm: async ({ message }) =>
					message.startsWith("Execute the reviewed") ? flags.owner : message.startsWith("Have application") ? flags.service : true,
				text: async ({ message }) => (message.startsWith("Type ") ? String(f.config.network.chainId) : receipts[message.split(" ")[1]] || ""),
			};
			let state = await runner.start(task.id, { ui, input: f.input });
			assert.equal(state.status, "waiting_external", state.lastError);
			assert.equal(phases.filter(p => p === "deploy").length, 1);
			if (kind === "safe") {
				for (const key of ["pause", "cut"]) {
					assert.ok(state.safeDispatches[key]);
					receipts[key] = "0x" + "a".repeat(64);
					state = await runner.resumeActive({ ui });
					assert.equal(state.status, "waiting_external", state.lastError);
				}
			} else {
				assert.equal(phases.includes("execute-governance"), false);
				flags.owner = true;
				state = await runner.resumeActive({ ui });
				assert.equal(state.status, "waiting_external", state.lastError);
			}
			assert.match(state.waitingFor, /application and indexer checks/);
			flags.service = true;
			state = await runner.resumeActive({ ui });
			if (kind === "safe") {
				assert.ok(state.safeDispatches.unpause);
				receipts.unpause = "0x" + "b".repeat(64);
				state = await runner.resumeActive({ ui });
			}
			assert.equal(state.status, "completed", state.lastError);
			assert.equal(phases.filter(p => p === "deploy").length, 1);
			assert.equal(phases.filter(p => p === "rehearse-initial").length, 1);
			assert.equal(phases.filter(p => p === "rehearse-cut").length, 1);
			assert.equal(read(f.input.output).status, "complete");
		});
	}
