import { digest } from "../../deployment-tooling/arbitrum-core-upgrade.js";
import { assertCoreUpgradeSourceBinding } from "../../deployment-tooling/core-upgrade-binding.js";
import { createTaskRunner } from "../task-runner.js";
import { prepareStandardCoreUpgrade, CORE_GIT_RELEASE_PLAN } from "../tasks/core-upgrade.js";
import { TASK_DEFINITIONS } from "../tasks/registry.js";
import { coreUpgradeFixture, read } from "./fixtures/core-upgrade.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const definition = TASK_DEFINITIONS.find(task => task.id === "maintenance.core-upgrade");
const gitFor =
	root =>
	(...args) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function prepare(f, choice = "new") {
	const git = gitFor(f.root);
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "tag.gpgsign", "false");
	if (choice !== "skip") {
		const remote = path.join(f.root, "tasks/data/release.git");
		git("init", "--bare", "-q", remote);
		git("remote", "add", "release-mirror", remote);
	}
	const ui = {
		select: async ({ message }) =>
			message === "Core upgrade input file" ? read(f.input.input).inputSource : message === "Upgrade Git tag" ? choice : "release-mirror",
		text: async ({ initialValue }) => initialValue || "release/new",
		note() {},
	};
	return prepareStandardCoreUpgrade({ root: f.root, ui, askGitRelease: true });
}

function compileBoundaryRunner(f, input, { decision = "publish", failOnce = false } = {}) {
	let attempted = false;
	const run = (ctx, taskInput) =>
		definition.run(
			{
				...ctx,
				runProcess: async () => {
					assertCoreUpgradeSourceBinding(f.root, read(input.input));
					if (failOnce && !attempted) {
						attempted = true;
						throw new Error("Compilation interrupted");
					}
					ctx.wait("Stopped at compile boundary for local Git integration proof");
				},
			},
			taskInput,
		);
	const task = { ...definition, run, handler: run };
	const runner = createTaskRunner({ root: f.root, definitions: [task] });
	const choices = [];
	const ui = {
		note() {},
		select: async ({ message }) => {
			choices.push(message);
			return decision;
		},
	};
	return { runner, ui, choices };
}

test("live preparation can skip Git with no remote; fork rehearsal remains independent", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f, "skip");
	assert.equal(input.releaseGit, undefined);
	assert.equal(
		definition.plan({}, input).some(step => step.id.startsWith("git-")),
		false,
	);
	assert.equal(definition.plan({}, input).at(-1).id, "publish");
	const { runner, ui } = compileBoundaryRunner(f, input);
	const head = gitFor(f.root)("rev-parse", "HEAD");
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(gitFor(f.root)("rev-parse", "HEAD"), head);
	assert.equal(fs.existsSync(path.join(path.dirname(input.output), "git-release.json")), false);
	const rehearsal = TASK_DEFINITIONS.find(task => task.id === "maintenance.core-upgrade-rehearse");
	assert.equal(
		rehearsal.plan().some(step => step.id.startsWith("git-")),
		false,
	);
});

test("Core always tags its deployment release while preserving a newer tooling commit and recovery", async t => {
	const f = await coreUpgradeFixture(t);
	const git = gitFor(f.root);
	const releaseCommit = git("rev-parse", "HEAD");
	git("tag", "-d", f.config.release.ref);
	git("branch", f.config.release.ref, releaseCommit);
	fs.writeFileSync(path.join(f.root, "cli/source.js"), "// reviewed newer tooling\n");
	git("add", "cli/source.js");
	git("commit", "-qm", "feat(tooling): review upgrade runner");
	const input = await prepare(f);
	assert.equal(input.releaseGit.target.ref, `refs/heads/${f.config.release.ref}`);
	assert.equal(input.releaseGit.target.commit, releaseCommit);
	assert.deepEqual(definition.plan({}, input).slice(0, CORE_GIT_RELEASE_PLAN.length), CORE_GIT_RELEASE_PLAN);
	const { runner, ui } = compileBoundaryRunner(f, input, { failOnce: true });
	let state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "paused", state.lastError);
	assert.match(state.lastError, /Compilation interrupted/);
	const bound = read(input.input);
	assert.equal(bound.sourceCommit, input.sourceCommit);
	assert.equal(bound.sourceCommit, git("rev-parse", "HEAD"));
	assert.equal(bound.upgradeGitTag.commit, releaseCommit);
	assert.equal(bound.upgradeGitTag.targetRef, `refs/heads/${f.config.release.ref}`);
	assert.notEqual(bound.upgradeGitTag.commit, bound.sourceCommit);
	assert.equal(state.coreReleaseBinding.inputDigest, read(input.output).inputDigest);
	assert.ok(git("ls-remote", "release-mirror", "refs/tags/release/new^{}").startsWith(releaseCommit));
	const commit = bound.sourceCommit,
		object = bound.upgradeGitTag.tagObject;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(git("rev-parse", "HEAD"), commit);
	assert.equal(git("rev-parse", "refs/tags/release/new"), object);
	assert.equal(state.completedSteps.filter(step => step === "git-commit").length, 1);
	const changed = structuredClone(bound);
	changed.upgradeGitTag.commit = bound.sourceCommit;
	changed.upgradeGitTag.publication.commit = bound.sourceCommit;
	assert.throws(() => assertCoreUpgradeSourceBinding(f.root, changed), /Published upgrade Git tag binding changed/);
});

test("existing Core tags are informational and the upgrade requires a fresh tag name", async t => {
	const f = await coreUpgradeFixture(t);
	await assert.rejects(prepare(f, `tag:${f.config.release.ref}`), /Existing tags are information only/);
	const git = gitFor(f.root);
	git("tag", "release/new", f.config.release.ref);
	const original = git("rev-parse", "refs/tags/release/new");
	git("remote", "remove", "release-mirror");
	await assert.rejects(prepare(f), /Upgrade tag already exists/);
	assert.equal(git("rev-parse", "refs/tags/release/new"), original);
});

test("Skip tagging at review proceeds to Core work and stays skipped after interruption", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f);
	const { runner, ui, choices } = compileBoundaryRunner(f, input, { decision: "skip", failOnce: true });
	let state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "paused", state.lastError);
	assert.match(state.lastError, /Compilation interrupted/);
	assert.equal(gitFor(f.root)("rev-parse", "HEAD"), input.sourceCommit);
	assert.equal(gitFor(f.root)("tag", "--list", input.releaseGit.tag), "");
	assert.equal(read(input.gitReport).status, "skipped");
	assert.equal(read(input.gitReport).publication, undefined);
	assert.equal(read(input.input).upgradeGitTag, undefined);
	gitFor(f.root)("remote", "remove", "release-mirror");
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.match(state.waitingFor, /compile boundary/);
	assert.deepEqual(choices, ["Git release action"]);
	assert.equal(gitFor(f.root)("tag", "--list", input.releaseGit.tag), "");
});

test("cancelled Git review waits for the menu and can cancel the task without publication", async t => {
	const f = await coreUpgradeFixture(t),
		input = await prepare(f);
	const { runner, ui } = compileBoundaryRunner(f, input, { decision: null });
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.match(state.waitingFor, /Git release choice cancelled/);
	assert.equal(state.completedSteps.length, 0);
	const cancelled = await runner.cancelActive({ ui });
	assert.equal(cancelled.status, "cancelled");
	assert.equal(runner.getActive(), null);
	assert.equal(gitFor(f.root)("tag", "--list", input.releaseGit.tag), "");
});

test("skipped Git evidence remains bound and Core authority still applies after skipping", async t => {
	const f = await coreUpgradeFixture(t),
		input = await prepare(f);
	const { runner, ui } = compileBoundaryRunner(f, input, { decision: "skip" });
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	const report = read(input.gitReport);
	report.sourceCommit = "0".repeat(40);
	fs.writeFileSync(input.gitReport, JSON.stringify(report));
	await assert.rejects(runner.resumeActive({ ui }), /Skipped Git release evidence changed/);
});

test("the durable skip record recovers an interrupted task checkpoint without asking again", async t => {
	const f = await coreUpgradeFixture(t),
		input = await prepare(f);
	const { runner, ui, choices } = compileBoundaryRunner(f, input, { decision: "skip", failOnce: true });
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "paused", state.lastError);
	const activeFile = path.join(f.root, ".symmio/tasks/active.json"),
		active = read(activeFile);
	delete active.coreGitReleaseSkipDigest;
	active.completedSteps = [];
	fs.writeFileSync(activeFile, JSON.stringify(active));
	const resumed = await runner.resumeActive({ ui });
	assert.equal(resumed.status, "waiting_external", resumed.lastError);
	assert.match(resumed.waitingFor, /compile boundary/);
	assert.deepEqual(choices, ["Git release action"]);
	assert.equal(read(input.gitReport).status, "skipped");
});

test("skipping Git still stops at the chain deployment authorization gate", async t => {
	const f = await coreUpgradeFixture(t),
		input = await prepare(f);
	const phases = [];
	const run = (ctx, taskInput) =>
		definition.run(
			{
				...ctx,
				runProcess: async (_command, args) => {
					const phase = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : "compile";
					phases.push(phase);
					assert.ok(["compile", "inspect"].includes(phase));
					if (phase === "inspect") {
						const report = read(input.output);
						report.initial = { blockNumber: 100 };
						report.client = { changes: [], abiDigest: digest([]) };
						fs.writeFileSync(path.join(path.dirname(input.output), "core-abi.json"), "[]");
						fs.writeFileSync(input.output, JSON.stringify(report));
					}
				},
			},
			taskInput,
		);
	const runner = createTaskRunner({ root: f.root, definitions: [{ ...definition, run, handler: run }] }),
		ui = { note() {}, select: async () => "skip", text: async () => "" };
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.match(state.waitingFor, /Core deployments await explicit chain authorization/);
	assert.deepEqual(phases, ["compile", "inspect"]);
	assert.equal(state.transactions.length, 0);
	assert.equal(state.completedSteps.includes("deploy"), false);
});

test("published source reference is required and tracked edits are not silently committed", async t => {
	const f = await coreUpgradeFixture(t);
	fs.writeFileSync(path.join(f.root, "cli/source.js"), "// staged tooling\n");
	gitFor(f.root)("add", "cli/source.js");
	await assert.rejects(prepare(f), /clean, committed tooling checkout/);
});

test("resuming refuses a removed remote publication before continuing Core work", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f);
	const { runner, ui } = compileBoundaryRunner(f, input);
	let state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	gitFor(f.root)("push", "-q", "release-mirror", ":refs/tags/release/new");
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "paused", state.lastError);
	assert.match(state.lastError, /Published upgrade tag is missing/);
});

test("release journal and Git-bound input drift are refused on continuation", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f);
	const { runner, ui } = compileBoundaryRunner(f, input);
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	const report = read(input.gitReport);
	report.publication.verifiedAt = "altered";
	fs.writeFileSync(input.gitReport, JSON.stringify(report));
	await assert.rejects(runner.resumeActive({ ui }), /publication evidence changed/);
});

test("the worker's source binding independently rejects a changed upgrade tag", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f);
	const { runner, ui } = compileBoundaryRunner(f, input);
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	gitFor(f.root)("tag", "-f", input.releaseGit.tag, "HEAD");
	assert.throws(() => assertCoreUpgradeSourceBinding(f.root, read(input.input)), /Published upgrade Git tag binding changed/);
});

test("skip still refuses tracked edits instead of silently committing them", async t => {
	const f = await coreUpgradeFixture(t);
	fs.writeFileSync(path.join(f.root, "cli/source.js"), "// staged edits\n");
	gitFor(f.root)("add", "cli/source.js");
	await assert.rejects(prepare(f, "skip"), /Commit tracked edits/);
});
