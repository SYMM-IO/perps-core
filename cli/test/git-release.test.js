import { prepareGitRelease, runGitReleasePhase, validateGitRelease } from "../lib/git-release.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "git-release-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const root = path.join(directory, "checkout"),
		remote = path.join(directory, "remote.git");
	fs.mkdirSync(root);
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "tag.gpgsign", "false");
	fs.writeFileSync(path.join(root, ".gitignore"), "evidence/\n");
	fs.writeFileSync(path.join(root, "release.txt"), "reviewed\n");
	git("add", ".gitignore", "release.txt");
	git("commit", "-qm", "test: seed release");
	git("init", "--bare", "-q", remote);
	git("remote", "add", "release-mirror", remote);
	const report = path.join(root, "evidence", "release.json");
	const ui = (tag = "release/new") => ({
		select: async ({ message }) => (message === "Upgrade Git tag" ? "new" : "release-mirror"),
		text: async ({ initialValue }) => initialValue || tag,
		note() {},
	});
	return { root, remote, git, report, ui };
}

async function complete(f, intent) {
	for (const phase of ["inspect", "commit", "tag", "publish"]) await runGitReleasePhase(f.root, intent, f.report, phase);
	return validateGitRelease(f.root, intent, f.report);
}

function releaseBranch(f) {
	const commit = f.git("rev-parse", "HEAD");
	f.git("branch", "version_0.8.6", commit);
	fs.writeFileSync(path.join(f.root, "tooling.txt"), "new operator tooling\n");
	f.git("add", "tooling.txt");
	f.git("commit", "-qm", "feat(tooling): add operator workflow");
	const ui = {
		...f.ui(),
		select: async ({ message }) => (message === "Upgrade Git tag" ? "new" : message === "Git tag target" ? "release" : "release-mirror"),
	};
	return { commit, sourceCommit: f.git("rev-parse", "HEAD"), ui };
}

test("release-branch tag publishes that commit while keeping the tooling checkout pinned", async t => {
	const f = fixture(t),
		release = releaseBranch(f),
		branch = f.git("symbolic-ref", "HEAD");
	const intent = await prepareGitRelease({ root: f.root, ui: release.ui, targetRef: "version_0.8.6" });
	assert.deepEqual(intent.target, {
		ref: "refs/heads/version_0.8.6",
		commit: release.commit,
		tree: f.git("rev-parse", `${release.commit}^{tree}`),
	});
	const report = await complete(f, intent);
	assert.equal(report.commit, release.commit);
	assert.equal(report.sourceCommit, release.sourceCommit);
	assert.equal(f.git("rev-parse", "refs/tags/release/new^{commit}"), release.commit);
	assert.equal(f.git("rev-parse", "HEAD"), release.sourceCommit);
	assert.equal(f.git("symbolic-ref", "HEAD"), branch);
	assert.equal(f.git("rev-parse", "refs/heads/version_0.8.6"), release.commit);
	assert.deepEqual(
		f
			.git("ls-remote", "release-mirror")
			.split("\n")
			.map(line => line.split(/\s+/)[1]),
		["refs/tags/release/new", "refs/tags/release/new^{}"],
	);
	await runGitReleasePhase(f.root, intent, f.report, "verify-publication");
});

test("tagging another release requires clean tooling and refuses a mismatched contracts tree", async t => {
	const f = fixture(t),
		release = releaseBranch(f);
	fs.writeFileSync(path.join(f.root, "tooling.txt"), "staged change\n");
	f.git("add", "tooling.txt");
	await assert.rejects(prepareGitRelease({ root: f.root, ui: release.ui, targetRef: "version_0.8.6" }), /clean, committed tooling checkout/);
	f.git("commit", "-qm", "feat(tooling): review change");
	fs.mkdirSync(path.join(f.root, "contracts"));
	fs.writeFileSync(path.join(f.root, "contracts/Release.sol"), "// other release\n");
	f.git("add", "contracts/Release.sol");
	f.git("commit", "-qm", "feat(core): change release");
	await assert.rejects(
		prepareGitRelease({ root: f.root, ui: release.ui, targetRef: "HEAD", contractsTree: f.git("rev-parse", "HEAD:contracts") }),
		/immutable branch, tag or commit/,
	);
	await assert.rejects(
		prepareGitRelease({ root: f.root, ui: release.ui, targetRef: "version_0.8.6", contractsTree: f.git("rev-parse", "HEAD:contracts") }),
		/Tag target Solidity differs/,
	);
});

test("an existing tag on the selected release can be reused but a tag on tooling HEAD cannot", async t => {
	const f = fixture(t),
		release = releaseBranch(f);
	f.git("tag", "-a", "-m", "Existing Core release", "chosen", release.commit);
	const object = f.git("rev-parse", "refs/tags/chosen"),
		ui = { ...release.ui, select: async options => (options.message === "Upgrade Git tag" ? "tag:chosen" : release.ui.select(options)) };
	const intent = await prepareGitRelease({ root: f.root, ui, targetRef: "version_0.8.6" }),
		report = await complete(f, intent);
	assert.equal(report.tagObject, object);
	assert.equal(report.commit, release.commit);
	f.git("tag", "wrong", "HEAD");
	await assert.rejects(
		prepareGitRelease({
			root: f.root,
			ui: { ...ui, select: async options => (options.message === "Upgrade Git tag" ? "tag:wrong" : ui.select(options)) },
			targetRef: "version_0.8.6",
		}),
		/Existing upgrade tag must point to the selected release/,
	);
});

test("release ref, tooling commit and tag target remain bound after review and publication", async t => {
	const f = fixture(t),
		release = releaseBranch(f),
		intent = await prepareGitRelease({ root: f.root, ui: release.ui, targetRef: "version_0.8.6" });
	f.git("branch", "-f", "version_0.8.6", "HEAD");
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /Git tag target reference changed/);
	f.git("branch", "-f", "version_0.8.6", release.commit);
	const report = await complete(f, intent);
	fs.writeFileSync(f.report, JSON.stringify({ ...report, sourceCommit: release.commit }));
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /Git release commit changed/);
	fs.writeFileSync(f.report, JSON.stringify(report));
	f.git("tag", "-f", intent.tag, "HEAD");
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /tag changed/);
});

test("new tag publishes the reviewed clean commit without pushing branches or unrelated tags", async t => {
	const f = fixture(t);
	f.git("tag", "-a", "-m", "Unrelated tag", "unrelated");
	f.git("config", "push.followTags", "true");
	const intent = await prepareGitRelease({ root: f.root, ui: f.ui() });
	const report = await complete(f, intent);
	assert.equal(report.commit, intent.previousHead);
	assert.equal(f.git("cat-file", "-t", report.tagObject), "tag");
	assert.deepEqual(
		f
			.git("ls-remote", "release-mirror")
			.split("\n")
			.map(line => line.split(/\s+/)[1]),
		["refs/tags/release/new", "refs/tags/release/new^{}"],
	);
	await runGitReleasePhase(f.root, intent, f.report, "publish");
	assert.equal(validateGitRelease(f.root, intent, f.report).tagObject, report.tagObject);
});

test("commit uses precisely the reviewed index and leaves untracked files alone", async t => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.root, "release.txt"), "upgrade\n");
	fs.writeFileSync(path.join(f.root, "operator-secret.txt"), "not staged\n");
	f.git("add", "release.txt");
	const intent = await prepareGitRelease({ root: f.root, ui: f.ui() });
	const report = await complete(f, intent);
	assert.notEqual(report.commit, intent.previousHead);
	assert.equal(f.git("show", "-s", "--format=%s", "HEAD"), intent.commitMessage);
	assert.equal(f.git("rev-parse", "HEAD^{tree}"), intent.tree);
	assert.equal(f.git("ls-tree", "--name-only", "HEAD").includes("operator-secret.txt"), false);
});

test("existing annotated and lightweight tags can be selected and published without being recreated", async t => {
	for (const annotated of [true, false]) {
		const f = fixture(t);
		f.git("tag", ...(annotated ? ["-a", "-m", "Existing release"] : []), "chosen");
		const object = f.git("rev-parse", "refs/tags/chosen");
		const ui = { ...f.ui(), select: async ({ message }) => (message === "Upgrade Git tag" ? "tag:chosen" : "release-mirror") };
		const intent = await prepareGitRelease({ root: f.root, ui });
		const report = await complete(f, intent);
		assert.equal(report.tagObject, object);
	}
});

test("dirty checkout, invalid tag and an existing tag on a different commit are refused", async t => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.root, "release.txt"), "unstaged\n");
	await assert.rejects(prepareGitRelease({ root: f.root, ui: f.ui() }), /Stage reviewed/);
	f.git("add", "release.txt");
	await assert.rejects(prepareGitRelease({ root: f.root, ui: f.ui("bad tag") }), /check-ref-format/);
	f.git("tag", "old");
	const ui = { ...f.ui(), select: async ({ message }) => (message === "Upgrade Git tag" ? "tag:old" : "release-mirror") };
	await assert.rejects(prepareGitRelease({ root: f.root, ui }), /Existing upgrade tag/);
	f.git("commit", "-qm", "test: advance");
	await assert.rejects(prepareGitRelease({ root: f.root, ui }), /Existing upgrade tag/);
});

test("changed index, branch, remote or tag cannot drift after review", async t => {
	const f = fixture(t);
	const intent = await prepareGitRelease({ root: f.root, ui: f.ui() });
	fs.writeFileSync(path.join(f.root, "release.txt"), "changed\n");
	f.git("add", "release.txt");
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /tree or checked-out branch changed/);
	f.git("reset", "--hard", "-q", "HEAD");
	f.git("switch", "-qc", "another");
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /tree or checked-out branch changed/);
	f.git("switch", "-q", intent.headRef.slice("refs/heads/".length));
	f.git("remote", "set-url", "--push", "release-mirror", path.join(f.root, "another.git"));
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /remote configuration changed/);
	f.git("remote", "set-url", "--push", "release-mirror", f.remote);
	const report = await complete(f, intent);
	f.git("tag", "-f", intent.tag, "HEAD");
	assert.throws(() => validateGitRelease(f.root, intent, f.report), /tag changed/);
	assert.notEqual(f.git("rev-parse", `refs/tags/${intent.tag}`), report.tagObject);
});

test("unknown commit/tag checkpoint outcomes are reconciled and a remote conflict is never overwritten", async t => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.root, "release.txt"), "upgrade\n");
	f.git("add", "release.txt");
	const intent = await prepareGitRelease({ root: f.root, ui: f.ui() });
	await runGitReleasePhase(f.root, intent, f.report, "inspect");
	f.git("commit", "-qm", intent.commitMessage);
	const committed = f.git("rev-parse", "HEAD");
	await runGitReleasePhase(f.root, intent, f.report, "commit");
	f.git("tag", "-a", "-m", intent.annotation, intent.tag);
	const tagged = f.git("rev-parse", `refs/tags/${intent.tag}`);
	await runGitReleasePhase(f.root, intent, f.report, "tag");
	f.git("push", "-q", "release-mirror", `${intent.previousHead}:refs/tags/${intent.tag}`);
	await assert.rejects(runGitReleasePhase(f.root, intent, f.report, "publish"), /refusing to replace/);
	assert.equal(f.git("rev-parse", "HEAD"), committed);
	assert.equal(f.git("rev-parse", `refs/tags/${intent.tag}`), tagged);
	assert.equal(f.git("ls-remote", "--refs", "release-mirror", `refs/tags/${intent.tag}`).split(/\s+/)[0], intent.previousHead);
});

test("retry reconciles a completed push before its publication checkpoint", async t => {
	const f = fixture(t);
	const intent = await prepareGitRelease({ root: f.root, ui: f.ui() });
	for (const phase of ["inspect", "commit", "tag"]) await runGitReleasePhase(f.root, intent, f.report, phase);
	f.git("push", "-q", "release-mirror", `refs/tags/${intent.tag}:refs/tags/${intent.tag}`);
	await runGitReleasePhase(f.root, intent, f.report, "publish");
	assert.equal(validateGitRelease(f.root, intent, f.report).publication.commit, intent.previousHead);
});

test("remote verification follows the single configured push URL, not the fetch URL", async t => {
	const f = fixture(t);
	const fetchRemote = path.join(f.root, "fetch.git");
	f.git("init", "--bare", "-q", fetchRemote);
	f.git("remote", "set-url", "release-mirror", fetchRemote);
	f.git("remote", "set-url", "--push", "release-mirror", f.remote);
	const intent = await prepareGitRelease({ root: f.root, ui: f.ui() });
	await complete(f, intent);
	assert.equal(f.git("ls-remote", "release-mirror"), "");
	assert.ok(f.git("ls-remote", f.remote).includes(`refs/tags/${intent.tag}`));
	f.git("remote", "set-url", "--add", "--push", "release-mirror", fetchRemote);
	await assert.rejects(prepareGitRelease({ root: f.root, ui: f.ui("another") }), /exactly one push URL/);
});

test("skip does not require a remote or mutate the commit, index or tags", async t => {
	const f = fixture(t);
	f.git("remote", "remove", "release-mirror");
	const before = [f.git("rev-parse", "HEAD"), f.git("ls-files", "--stage"), f.git("tag", "--list")];
	const intent = await prepareGitRelease({ root: f.root, ui: { select: async () => "skip" } });
	assert.equal(intent, false);
	assert.deepEqual([f.git("rev-parse", "HEAD"), f.git("ls-files", "--stage"), f.git("tag", "--list")], before);
	assert.equal(fs.existsSync(f.report), false);
});
