import {
	assertReleaseSource,
	buildRoundingInput,
	RECIPE_PATH,
	RELEASE_TAG,
	PRODUCTION_RELEASE_TAG,
	TARGET_PATH,
	ROUNDING_PROFILES,
	requiresRoundingPause,
	roundingDeployments,
	validateRoundingSourceMigration,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { createTaskRunner } from "../task-runner.js";
import { PREVIOUS_PRODUCTION_ROUNDING_PLAN, PRODUCTION_ROUNDING_PLAN, migrateProductionCutPlan } from "../tasks/arbitrum-rounding-upgrade.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { Interface, id, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function releaseFixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-rounding-source-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const write = (file, text) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), text);
	};
	git(["init", "-q"]);
	git(["config", "user.name", "Release Test"]);
	git(["config", "user.email", "release@example.invalid"]);
	git(["config", "core.hooksPath", "/dev/null"]);
	const commit = files => {
		git(["add", "--", ...files]);
		git(["-c", "commit.gpgSign=false", "commit", "-qm", "test fixture"]);
		return git(["rev-parse", "HEAD"]);
	};
	write("contracts/Test.sol", "pragma solidity >=0.8.18; contract Test {}\n");
	const releaseCommit = commit(["contracts/Test.sol"]);
	git(["tag", RELEASE_TAG]);
	const safe = "0x1111111111111111111111111111111111111111";
	write(TARGET_PATH, JSON.stringify({ safe, contractsTree: git(["rev-parse", "HEAD:contracts"]) }));
	write(
		RECIPE_PATH,
		JSON.stringify({
			name: "arbitrum-vibe-stage",
			governance: { admin: safe },
			create2: { factory: { mode: "deploy" }, groups: { facets: { suffix: "862" } } },
		}),
	);
	const sourceCommit = commit([TARGET_PATH, RECIPE_PATH]);
	return { root, git, write, commit, releaseCommit, sourceCommit };
}

function addFundingRelease(fixture) {
	fixture.write("contracts/Funding.sol", "pragma solidity >=0.8.18; contract Funding {}\n");
	const releaseCommit = fixture.commit(["contracts/Funding.sol"]);
	fixture.git(["tag", PRODUCTION_RELEASE_TAG]);
	return releaseCommit;
}

function stageFundingFixture(t) {
	const fixture = releaseFixture(t);
	addFundingRelease(fixture);
	const profile = ROUNDING_PROFILES["stage-funding"];
	const recipe = JSON.parse(fs.readFileSync(new URL(`../../${profile.recipePath}`, import.meta.url)));
	const target = JSON.parse(fs.readFileSync(new URL(`../../${profile.targetPath}`, import.meta.url)));
	target.contractsTree = fixture.git(["rev-parse", "HEAD:contracts"]);
	fixture.write(profile.recipePath, JSON.stringify(recipe));
	fixture.write(profile.targetPath, JSON.stringify(target));
	fixture.write(".gitignore", ".symmio/\ntasks/data/\n");
	fixture.commit([profile.recipePath, profile.targetPath, ".gitignore"]);
	return { ...fixture, profile, recipe, target };
}

test("stage funding pins suffix 863 and the funding Solidity tag without changing production's 862 suffix", t => {
	const fixture = stageFundingFixture(t);
	const input = buildRoundingInput(fixture.root, "stage-funding");
	assert.equal(input.apiVersion, "operations.symm.io/arbitrum-funding-upgrade-v1");
	assert.equal(input.release, PRODUCTION_RELEASE_TAG);
	assert.equal(input.create2.groups.facets.suffix, "863");
	assert.equal(requiresRoundingPause(input), true);
	assert.doesNotThrow(() => assertReleaseSource(fixture.root, input));
	assert.throws(
		() => assertReleaseSource(fixture.root, { ...input, apiVersion: "operations.symm.io/arbitrum-rounding-upgrade-v3" }),
		/differs from/,
	);
	assert.equal(
		JSON.parse(fs.readFileSync(new URL("../../deployment-recipes/arbitrum-vibe-production-862.json", import.meta.url))).create2.groups.facets
			.suffix,
		"862",
	);
	fixture.recipe.create2.groups.facets.suffix = "862";
	fixture.write(fixture.profile.recipePath, JSON.stringify(fixture.recipe));
	fixture.commit([fixture.profile.recipePath]);
	assert.throws(() => buildRoundingInput(fixture.root, "stage-funding"), /exactly suffix 863/);
});

test("stage funding exports distinct Safe files and resumes through roles, pause, cut, verification and unpause", async t => {
	const fixture = stageFundingFixture(t);
	const base = TASK_DEFINITIONS.find(task => task.id === "maintenance.arbitrum-vibe-stage-funding-upgrade-863");
	const core = fixture.target.core,
		safe = fixture.target.safe;
	const iface = new Interface([
		"function grantRole(address,bytes32)",
		"function pauseGlobal()",
		"function unpauseGlobal()",
		"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[],address,bytes)",
	]);
	const action = (method, args = []) => ({ to: core, value: "0", data: iface.encodeFunctionData(method, args), description: method });
	let roles = false,
		paused = false,
		installed = false,
		verified = false,
		unpaused = false;
	const phases = [];
	const ui = {
		note: () => {},
		select: async () => "hardhat-keystore",
		confirm: async () => false,
		text: async ({ message }) => (message.endsWith("keystore key") ? "NEW_DEPLOYER" : "UPGRADE VIBE STAGE FUNDING 863 ON 42161"),
	};
	const input = await base.prepare({ root: fixture.root, ui });
	assert.equal(input.governanceSigner.mode, "safe-file");
	const task = {
		...base,
		run: async (ctx, prepared) =>
			base.run(
				{
					...ctx,
					runProcess: async (command, args) => {
						const phase = command === "npm" ? "compile" : args[args.indexOf("--phase") + 1];
						phases.push(phase);
						const report = fs.existsSync(prepared.output)
							? JSON.parse(fs.readFileSync(prepared.output))
							: { inputDigest: prepared.inputDigest };
						if (phase === "plan-roles")
							report.roles = {
								actions: roles
									? []
									: [action("grantRole", [safe, id("PAUSER_ROLE")]), action("grantRole", [safe, id("UNPAUSER_ROLE")])],
							};
						if (phase === "verify-roles") assert(roles);
						if (phase === "plan-pause") {
							assert(roles);
							report.pause = { actions: paused ? [] : [action("pauseGlobal")] };
						}
						if (phase === "verify-pause") assert(paused);
						if (phase === "plan") {
							assert(paused);
							report.actions = installed
								? []
								: [
										action("diamondCut", [
											[
												{
													facetAddress: "0x1111111111111111111111111111111111111863",
													action: 1,
													functionSelectors: ["0xfe9e82df"],
												},
											],
											ZeroAddress,
											"0x",
										]),
									];
						}
						if (phase === "verify") {
							assert(installed && paused);
							verified = true;
						}
						if (phase === "plan-unpause") {
							assert(verified);
							report.unpause = { actions: unpaused ? [] : [action("unpauseGlobal")] };
						}
						if (phase === "verify-unpause") assert(unpaused);
						fs.writeFileSync(prepared.output, JSON.stringify(report));
					},
				},
				prepared,
			),
	};
	task.handler = task.run;
	const runner = createTaskRunner({ root: fixture.root, definitions: [task] });
	let state = await runner.start(task.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.deepEqual(state.completedSteps, ["compile", "inspect", "authorize", "deploy", "publish"]);
	const originalInputHash = state.inputHash;
	const files = [];
	const checkExport = (key, method, count) => {
		const delivery = state.safeDispatches[key];
		files.push(delivery.builderPath);
		const batch = JSON.parse(fs.readFileSync(delivery.builderPath));
		assert.equal(batch.transactions.length, count);
		for (const tx of batch.transactions) {
			assert.equal(tx.to.toLowerCase(), core.toLowerCase());
			assert.equal(tx.value, "0");
			assert.equal(iface.parseTransaction({ data: tx.data }).name, method);
		}
	};
	checkExport("funding-core-roles", "grantRole", 2);
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external");
	assert.equal(state.safeDispatches["funding-core-roles"].builderPath, files[0]);
	roles = true;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	checkExport("funding-core-pause", "pauseGlobal", 1);
	paused = true;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	checkExport("rounding-core-cut", "diamondCut", 1);
	assert.equal(verified, false);
	installed = true;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	checkExport("rounding-core-unpause", "unpauseGlobal", 1);
	unpaused = true;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "completed", state.lastError);
	assert.equal(state.inputHash, originalInputHash);
	assert.equal(new Set(files).size, 4);
	assert.equal(phases.filter(p => p === "deploy").length, 1);
	assert.equal(phases.filter(p => p === "publish").length, 1);
});

test("Solidity tag stays fixed while a clean descendant binds its deployment-script commit", t => {
	const fixture = releaseFixture(t);
	const input = buildRoundingInput(fixture.root);
	assert.equal(input.releaseCommit, fixture.releaseCommit);
	assert.equal(input.sourceCommit, fixture.sourceCommit);
	assert.notEqual(input.releaseCommit, input.sourceCommit);
	assert.equal(assertReleaseSource(fixture.root, input), fixture.sourceCommit);
	assert.throws(() => assertReleaseSource(fixture.root, { ...input, releaseCommit: fixture.sourceCommit }), /changed since preparation/);
	fixture.write("operator.js", "// later script update\n");
	const next = fixture.commit(["operator.js"]);
	assert.throws(() => assertReleaseSource(fixture.root, input), /changed since preparation/);
	assert.equal(buildRoundingInput(fixture.root).sourceCommit, next);
	assert.equal(buildRoundingInput(fixture.root).releaseCommit, fixture.releaseCommit);
});

test("changed Solidity or moving the tag to a tooling commit is refused", t => {
	const fixture = releaseFixture(t);
	fixture.git(["tag", "-f", RELEASE_TAG, fixture.sourceCommit]);
	assert.throws(() => buildRoundingInput(fixture.root), /contract source change/);
	fixture.git(["tag", "-f", RELEASE_TAG, fixture.releaseCommit]);
	fixture.write("contracts/Test.sol", "pragma solidity >=0.8.18; contract Test { uint256 public changed; }\n");
	assert.throws(() => buildRoundingInput(fixture.root), /clean tracked worktree/);
	fixture.commit(["contracts/Test.sol"]);
	assert.throws(() => buildRoundingInput(fixture.root), /Contracts differ.*\.releases\/version_0\.8\.6\.2/);
});

test("production binds a separate recipe and target without moving the Solidity release tag", t => {
	const fixture = releaseFixture(t);
	const stage = buildRoundingInput(fixture.root);
	const fundingCommit = addFundingRelease(fixture);
	const profile = ROUNDING_PROFILES.production;
	const target = JSON.parse(fs.readFileSync(path.join(fixture.root, TARGET_PATH)));
	target.contractsTree = fixture.git(["rev-parse", "HEAD:contracts"]);
	target.core = "0x2222222222222222222222222222222222222222";
	target.owner = target.safe;
	target.governanceMode = "ledger";
	delete target.safe;
	const recipe = JSON.parse(fs.readFileSync(path.join(fixture.root, RECIPE_PATH)));
	recipe.name = profile.recipeName;
	fixture.write(profile.targetPath, JSON.stringify(target));
	fixture.write(profile.recipePath, JSON.stringify(recipe));
	fixture.commit([profile.targetPath, profile.recipePath]);
	const production = buildRoundingInput(fixture.root, "production");
	assert.equal(production.profile, "production");
	assert.equal(production.apiVersion, "operations.symm.io/arbitrum-rounding-upgrade-v5");
	assert.equal(production.release, PRODUCTION_RELEASE_TAG);
	assert.equal(production.releaseCommit, fundingCommit);
	assert.notEqual(production.releaseCommit, stage.releaseCommit);
	assert.equal(fixture.git(["rev-parse", `${RELEASE_TAG}^{commit}`]), stage.releaseCommit);
	assert.equal(production.create2.groups.facets.suffix, "862");
	assert.notEqual(production.targetDigest, stage.targetDigest);
	assert.notEqual(production.recipeDigest, stage.recipeDigest);
	assert.equal(requiresRoundingPause(production), false);
	assert.equal(requiresRoundingPause(stage), false);
	assert.doesNotThrow(() => assertReleaseSource(fixture.root, production));
	assert.throws(() => assertReleaseSource(fixture.root, { ...production, profile: "stage" }), /Contracts differ/);
	assert.throws(() => assertReleaseSource(fixture.root, { ...production, apiVersion: stage.apiVersion }), /differs from the release target/);
	assert.throws(
		() => assertReleaseSource(fixture.root, { ...production, apiVersion: "operations.symm.io/arbitrum-rounding-upgrade-v4" }),
		/differs from the release target/,
	);
	fixture.git(["tag", "-f", PRODUCTION_RELEASE_TAG, production.sourceCommit]);
	assert.throws(() => buildRoundingInput(fixture.root, "production"), /contract source change/);
	fixture.git(["tag", "-f", PRODUCTION_RELEASE_TAG, fundingCommit]);
	assert.throws(() => buildRoundingInput(fixture.root, "unknown"), /Unknown rounding upgrade profile/);
	fixture.write(profile.recipePath, JSON.stringify({ ...recipe, governance: { admin: target.core } }));
	fixture.commit([profile.recipePath]);
	assert.throws(() => buildRoundingInput(fixture.root, "production"), /reviewed Core owner/);
});

test("production deploys without Ledger setup, waits for the admin, and resumes without redeployment or changing input", async t => {
	const fixture = releaseFixture(t);
	addFundingRelease(fixture);
	const profile = ROUNDING_PROFILES.production;
	const recipe = JSON.parse(fs.readFileSync(new URL("../../deployment-recipes/arbitrum-vibe-production-862.json", import.meta.url)));
	const target = {
		core: "0x2222222222222222222222222222222222222222",
		owner: recipe.governance.admin,
		governanceMode: "ledger",
		contractsTree: fixture.git(["rev-parse", "HEAD:contracts"]),
	};
	fixture.write(profile.recipePath, JSON.stringify(recipe));
	fixture.write(profile.targetPath, JSON.stringify(target));
	fixture.write(".gitignore", ".symmio/\ntasks/data/\n");
	fixture.commit([profile.recipePath, profile.targetPath, ".gitignore"]);
	const base = TASK_DEFINITIONS.find(task => task.id === "maintenance.arbitrum-vibe-production-rounding-upgrade-862");
	const calls = [];
	let phase = "prepare",
		adminReady = false,
		interruptAfterCut = false;
	const ui = {
		note: () => {},
		select: async ({ message }) => {
			if (message === "Contract deployment signer and temporary factory admin") return "hardhat-keystore";
			assert.notEqual(phase, "prepare", "Preparation must never request the Ledger");
			if (message.startsWith("Deployment and explorer")) {
				assert(calls.includes("publish"), "Publication must finish before requesting the admin");
				return adminReady ? "ledger" : "later";
			}
			assert.equal(message, "Ledger derivation path family");
			return "ledger-live";
		},
		text: async ({ message }) => {
			if (message.endsWith("keystore key")) return "TEAM_DEPLOYER";
			assert.notEqual(phase, "prepare", "Preparation must never request a Ledger address");
			if (message === "Core owner Ledger Ledger address") return target.owner;
			assert(message.startsWith("Type UPGRADE VIBE PRODUCTION"));
			return `UPGRADE VIBE PRODUCTION ${PRODUCTION_RELEASE_TAG} ON 42161`;
		},
		confirm: async ({ message }) => {
			if (message.startsWith("Configure or refresh")) return false;
			assert.equal(message, "Ledger is connected and the Ethereum app is open?");
			assert.notEqual(phase, "prepare");
			return true;
		},
	};
	const input = await base.prepare({ root: fixture.root, ui });
	assert.equal(input.governanceSigner, undefined);
	assert.equal(input.signer.mode, "hardhat-keystore");
	const inputBefore = JSON.stringify(input);
	const task = {
		...base,
		run: async (ctx, prepared) => {
			const mocked = {
				...ctx,
				runProcess: async (command, args, { env }) => {
					const adapterPhase = command === "npm" ? "compile" : args[args.indexOf("--phase") + 1];
					if (interruptAfterCut && adapterPhase === "verify") throw new Error("test interruption after confirmed cut");
					calls.push(adapterPhase);
					if (adapterPhase.startsWith("execute-")) {
						assert.equal(env.SYMMIO_SIGNER_MODE, "ledger");
						assert.equal(env.SYMMIO_EXPECTED_SIGNER, target.owner);
						assert.equal(ctx.getSigner("governance").address, target.owner);
					} else assert.equal(env.SYMMIO_SIGNER_MODE, undefined);
					fs.writeFileSync(prepared.output, JSON.stringify({ inputDigest: prepared.inputDigest }));
				},
			};
			return base.run(mocked, prepared);
		},
	};
	task.handler = task.run;
	const runner = createTaskRunner({ root: fixture.root, definitions: [task] });
	phase = "execution";
	const waiting = await runner.start(task.id, { input, ui });
	assert.equal(waiting.status, "waiting_external", waiting.lastError);
	assert.deepEqual(waiting.completedSteps, ["compile", "inspect", "authorize", "deploy", "publish"]);
	assert.deepEqual(calls, ["compile", "inspect", "deploy", "publish"]);
	assert.equal(waiting.signing.governance, undefined);
	assert.equal(JSON.stringify(waiting.input), inputBefore);
	const inputHash = waiting.inputHash;
	adminReady = true;
	interruptAfterCut = true;
	const paused = await runner.resumeActive({ ui });
	assert.equal(paused.status, "paused");
	assert.match(paused.lastError, /test interruption/);
	assert.equal(paused.signing.governance.address, target.owner);
	assert.equal(paused.inputHash, inputHash);
	interruptAfterCut = false;
	const complete = await runner.resumeActive({ ui });
	assert.equal(complete.status, "completed", complete.lastError);
	assert.equal(complete.inputHash, inputHash);
	assert.equal(JSON.stringify(complete.input), inputBefore);
	assert.deepEqual(calls, ["compile", "inspect", "deploy", "publish", "execute-cut", "verify"]);
});

test("production migrates the published legacy run to cut-only and preserves inputs, deployments and evidence", async t => {
	const fixture = releaseFixture(t);
	addFundingRelease(fixture);
	const profile = ROUNDING_PROFILES.production;
	const recipe = JSON.parse(fs.readFileSync(new URL(`../../${profile.recipePath}`, import.meta.url)));
	const target = {
		core: "0x2222222222222222222222222222222222222222",
		owner: recipe.governance.admin,
		governanceMode: "ledger",
		contractsTree: fixture.git(["rev-parse", "HEAD:contracts"]),
	};
	fixture.write(profile.recipePath, JSON.stringify(recipe));
	fixture.write(profile.targetPath, JSON.stringify(target));
	fixture.write(".gitignore", ".symmio/\ntasks/data/\n");
	fixture.commit([profile.recipePath, profile.targetPath, ".gitignore"]);
	const base = TASK_DEFINITIONS.find(task => task.id === "maintenance.arbitrum-vibe-production-rounding-upgrade-862");
	let adminReady = false,
		approveMigration = false;
	const ui = {
		note: () => {},
		select: async ({ message }) =>
			message === "Contract deployment signer and temporary factory admin"
				? "hardhat-keystore"
				: message.startsWith("Deployment")
					? adminReady
						? "ledger"
						: "later"
					: "ledger-live",
		text: async ({ message, placeholder }) =>
			message.startsWith("Task source changed")
				? approveMigration
					? placeholder
					: null
				: message.endsWith("keystore key")
					? "TEAM_DEPLOYER"
					: target.owner,
		confirm: async ({ message }) => !message.startsWith("Configure or refresh"),
	};
	const input = await base.prepare({ root: fixture.root, ui });
	const standardBefore = fs.readFileSync(input.input, "utf8");
	const report = {
		inputDigest: input.inputDigest,
		deployments: Object.fromEntries(roundingDeployments("production").map(name => [name, { address: target.core, published: true }])),
		transactions: [],
	};
	const old = {
		...base,
		plan: () => PREVIOUS_PRODUCTION_ROUNDING_PLAN.map(step => ({ ...step })),
		run: async ctx => {
			assert.throws(() => ctx.migratePlan(PRODUCTION_ROUNDING_PLAN, "Unconfirmed change"), /requires confirmed source migration/);
			for (const step of PREVIOUS_PRODUCTION_ROUNDING_PLAN.slice(0, 5))
				await ctx.step(
					step.id,
					step.title,
					async () => {
						if (step.id === "deploy")
							for (const name of roundingDeployments("production")) {
								const tx = { hash: id(name), label: name, status: "submitted", from: "0x3333333333333333333333333333333333333333" };
								ctx.emit("tx.submitted", { transaction: tx });
								ctx.emit("tx.confirmed", { transaction: { ...tx, status: "confirmed" } });
							}
					},
					{ phase: step.phase },
				);
			fs.writeFileSync(input.output, JSON.stringify(report));
			ctx.wait("Wait for admin before the former pause step");
		},
	};
	old.handler = old.run;
	const oldRunner = createTaskRunner({ root: fixture.root, definitions: [old] });
	const waiting = await oldRunner.start(old.id, { input, ui });
	assert.equal(waiting.status, "waiting_external");
	const inputHash = waiting.inputHash,
		journal = JSON.stringify(waiting.transactions);
	fixture.write("cli/tasks/arbitrum-rounding-upgrade.js", "// reviewed cut-only workflow\n");
	fixture.commit(["cli/tasks/arbitrum-rounding-upgrade.js"]);
	const calls = [];
	const updated = {
		...base,
		run: (ctx, prepared) =>
			base.run(
				{
					...ctx,
					runProcess: async (_command, args, { env }) => {
						const phase = args[args.indexOf("--phase") + 1];
						calls.push(phase);
						const migration = JSON.parse(env.SYMMIO_ROUNDING_SOURCE_MIGRATION);
						assert.doesNotThrow(() => assertReleaseSource(fixture.root, JSON.parse(standardBefore), "production", migration));
						assert.throws(
							() => validateRoundingSourceMigration(fixture.root, JSON.parse(standardBefore), { ...migration, inputDigest: "changed" }),
							/does not match/,
						);
						assert.throws(
							() => validateRoundingSourceMigration(fixture.root, JSON.parse(standardBefore), { ...migration, migrations: [] }),
							/operator confirmation/,
						);
						assert(["execute-cut", "verify"].includes(phase));
						if (phase === "execute-cut") assert.equal(env.SYMMIO_SIGNER_MODE, "ledger");
					},
				},
				prepared,
			),
	};
	updated.handler = updated.run;
	const runner = createTaskRunner({ root: fixture.root, definitions: [updated] });
	await assert.rejects(() => runner.resumeActive({ ui }), /migration was not authorized/);
	assert.equal(runner.getActive().inputHash, inputHash);
	approveMigration = true;
	const migrated = await runner.resumeActive({ ui });
	assert.equal(migrated.status, "waiting_external", migrated.lastError);
	assert.deepEqual(migrated.plan, PRODUCTION_ROUNDING_PLAN);
	assert.equal(migrated.planMigrations.length, 1);
	assert.deepEqual(migrated.planMigrations[0].previousPlan, PREVIOUS_PRODUCTION_ROUNDING_PLAN);
	assert.equal(migrated.inputHash, inputHash);
	assert.equal(JSON.stringify(migrated.transactions), journal);
	assert.equal(fs.readFileSync(input.input, "utf8"), standardBefore);
	assert.deepEqual(calls, []);
	adminReady = true;
	const complete = await runner.resumeActive({ ui });
	assert.equal(complete.status, "completed", complete.lastError);
	assert.deepEqual(calls, ["execute-cut", "verify"]);
	assert.equal(complete.inputHash, inputHash);
	assert.equal(JSON.stringify(complete.transactions), journal);
	assert.equal(complete.completedSteps.length, 7);
	// An existing governance action or incomplete publication cannot be migrated away.
	const mock = { state: { ...waiting, plan: PREVIOUS_PRODUCTION_ROUNDING_PLAN }, migratePlan: () => assert.fail("must refuse"), ui };
	fs.writeFileSync(input.output, JSON.stringify({ ...report, governanceTransactions: [{ status: "confirmed" }] }));
	assert.throws(() => migrateProductionCutPlan(mock, input, {}), /no started governance/);
	fs.writeFileSync(input.output, JSON.stringify({ ...report, deployments: {} }));
	assert.throws(() => migrateProductionCutPlan(mock, input, {}), /ten published/);
	const migration = {
		taskId: base.id,
		taskRunId: waiting.runId,
		inputDigest: input.inputDigest,
		originalCommit: input.sourceCommit,
		currentCommit: fixture.git(["rev-parse", "HEAD"]),
		sourceHash: migrated.sourceHash,
		migrations: migrated.sourceMigrations,
	};
	fixture.write("scripts/unreviewed.js", "// outside the reviewed migration\n");
	migration.currentCommit = fixture.commit(["scripts/unreviewed.js"]);
	assert.throws(() => validateRoundingSourceMigration(fixture.root, JSON.parse(standardBefore), migration), /unapproved operational changes/);
	fixture.write("contracts/Test.sol", "pragma solidity >=0.8.18; contract Changed {}\n");
	migration.currentCommit = fixture.commit(["contracts/Test.sol"]);
	assert.throws(() => validateRoundingSourceMigration(fixture.root, JSON.parse(standardBefore), migration), /cannot change Solidity/);
});
