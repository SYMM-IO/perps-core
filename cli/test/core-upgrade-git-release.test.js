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

function compileBoundaryRunner(f, input, { authorize = true, failOnce = false } = {}) {
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
	const ui = { note() {}, confirm: async () => authorize };
	return { runner, ui };
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

test("runner commits staged source, publishes its tag and binds that exact commit before Core work", async t => {
	const f = await coreUpgradeFixture(t);
	fs.writeFileSync(path.join(f.root, "cli/source.js"), "// reviewed staged release\n");
	const git = gitFor(f.root);
	git("add", "cli/source.js");
	const input = await prepare(f);
	assert.deepEqual(definition.plan({}, input).slice(0, CORE_GIT_RELEASE_PLAN.length), CORE_GIT_RELEASE_PLAN);
	const { runner, ui } = compileBoundaryRunner(f, input, { failOnce: true });
	let state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "paused", state.lastError);
	assert.match(state.lastError, /Compilation interrupted/);
	const bound = read(input.input);
	assert.notEqual(bound.sourceCommit, input.sourceCommit);
	assert.equal(bound.sourceCommit, git("rev-parse", "HEAD"));
	assert.equal(bound.upgradeGitTag.commit, bound.sourceCommit);
	assert.equal(state.coreReleaseBinding.inputDigest, read(input.output).inputDigest);
	assert.ok(git("ls-remote", "release-mirror", "refs/tags/release/new^{}").startsWith(bound.sourceCommit));
	const commit = bound.sourceCommit,
		object = bound.upgradeGitTag.tagObject;
	state = await runner.resumeActive({ ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(git("rev-parse", "HEAD"), commit);
	assert.equal(git("rev-parse", "refs/tags/release/new"), object);
	assert.equal(state.completedSteps.filter(step => step === "git-commit").length, 1);
});

test("operator can reuse an existing current tag through the live task", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f, `tag:${f.config.release.ref}`);
	const original = gitFor(f.root)("rev-parse", `refs/tags/${f.config.release.ref}`);
	const { runner, ui } = compileBoundaryRunner(f, input);
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(read(input.input).upgradeGitTag.tagObject, original);
});

test("declining Git release authorization leaves the commit and tag unchanged", async t => {
	const f = await coreUpgradeFixture(t);
	const input = await prepare(f);
	const { runner, ui } = compileBoundaryRunner(f, input, { authorize: false });
	const state = await runner.start(definition.id, { input, ui });
	assert.equal(state.status, "waiting_external", state.lastError);
	assert.equal(gitFor(f.root)("rev-parse", "HEAD"), input.sourceCommit);
	assert.equal(gitFor(f.root)("tag", "--list", input.releaseGit.tag), "");
	assert.equal(state.completedSteps.includes("compile"), false);
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
