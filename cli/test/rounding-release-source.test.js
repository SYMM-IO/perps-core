import {
	assertReleaseSource,
	buildRoundingInput,
	RECIPE_PATH,
	RELEASE_TAG,
	PRODUCTION_RELEASE_TAG,
	TARGET_PATH,
	ROUNDING_PROFILES,
	requiresRoundingPause,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { createTaskRunner } from "../task-runner.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
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
	assert.equal(requiresRoundingPause(production), true);
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
	assert.deepEqual(calls, [
		"compile",
		"inspect",
		"deploy",
		"publish",
		"execute-pause",
		"verify-pause",
		"execute-cut",
		"verify",
		"execute-unpause",
		"verify-unpause",
	]);
});
