import { digest } from "../../deployment-tooling/account-instant-upgrade.js";
import { taskOutputSink } from "./task-output.js";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(root, args, { optional = false } = {}) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
	} catch (error) {
		if (optional && error.status === 1) return null;
		throw new Error(`Git ${args[0]} failed; check repository configuration`);
	}
}

function writeReport(file, report) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

function remoteDigest(root, remote) {
	if (!git(root, ["remote"]).split("\n").includes(remote) || remote.startsWith("-")) throw new Error("Select a configured Git remote");
	const urls = git(root, ["remote", "get-url", "--push", "--all", remote]).split("\n");
	if (urls.length !== 1 || !urls[0]) throw new Error("Release publication requires a remote with exactly one push URL");
	return digest(urls[0]);
}

function snapshot(root) {
	if (git(root, ["ls-files", "--unmerged"])) throw new Error("Resolve Git conflicts before preparing a release");
	if (git(root, ["diff", "--quiet"], { optional: true }) === null) throw new Error("Stage reviewed tracked edits before preparing a release");
	return {
		previousHead: git(root, ["rev-parse", "HEAD"]),
		headRef: git(root, ["symbolic-ref", "--quiet", "HEAD"], { optional: true }),
		tree: git(root, ["write-tree"]),
	};
}

export async function prepareGitRelease({ root, ui, contractsTree }) {
	const tags = git(root, ["for-each-ref", "--sort=-creatordate", "--format=%(refname:strip=2)", "refs/tags"]).split("\n").filter(Boolean);
	const choice = await ui.select({
		message: "Upgrade Git tag",
		options: [
			{ value: "skip", label: "Skip Git release" },
			{ value: "new", label: "Create a new tag" },
			...tags.map(name => ({ value: `tag:${name}`, label: name })),
		],
	});
	if (choice === null) return null;
	if (choice === "skip") return false;
	const before = snapshot(root);
	if (contractsTree && git(root, ["rev-parse", `${before.tree}:contracts`]) !== contractsTree)
		throw new Error("Staged Solidity differs from the input's target release");
	const tag = choice === "new" ? await ui.text({ message: "New upgrade Git tag name" }) : choice.slice(4);
	if (!tag) return null;
	git(root, ["check-ref-format", `refs/tags/${tag}`]);
	const tagObject = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { optional: true });
	const changed = before.tree !== git(root, ["rev-parse", "HEAD^{tree}"]);
	if (tagObject && (changed || git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]) !== before.previousHead))
		throw new Error("Existing upgrade tag must point to HEAD with no staged edits; check out that tag first, or create a new tag");
	const remotes = git(root, ["remote"])
		.split("\n")
		.filter(name => name && !name.startsWith("-"));
	if (!remotes.length) throw new Error("Configure a Git remote before preparing a live upgrade release");
	const remote = await ui.select({ message: "Publish upgrade tag to Git remote", options: remotes.map(name => ({ value: name, label: name })) });
	if (remote === null) return null;
	const message = changed
		? await ui.text({ message: "Commit message for the reviewed staged changes", initialValue: `chore(release): prepare ${tag}` })
		: null;
	if (changed && !message) return null;
	if (changed && !/^[a-z]+(?:\([^\r\n()]+\))?!?: [^\r\n]+$/.test(message))
		throw new Error("Use a conventional, single-line release commit message");
	const intent = {
		apiVersion: "operations.symm.io/git-release-v1",
		...before,
		tag,
		remote,
		remoteDigest: remoteDigest(root, remote),
		existingTagObject: tagObject,
		commitMessage: message,
		annotation: `Upgrade release ${tag}`,
	};
	ui.note(
		`Tag: ${tag}\nRemote: ${remote}\nHEAD: ${before.previousHead}\n${changed ? git(root, ["diff", "--cached", "--stat"]) : "Use the existing clean commit."}\nOnly this tag and its reachable commits will be pushed.`,
		"Git release plan",
	);
	return intent;
}

function readReport(file, intent) {
	const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { intentDigest: digest(intent) };
	if (report.intentDigest !== digest(intent)) throw new Error("Git release journal intent changed");
	return report;
}

export function assertGitReleaseBinding(root, intent, report) {
	const current = snapshot(root);
	if (remoteDigest(root, intent.remote) !== intent.remoteDigest) throw new Error("Git release remote configuration changed");
	if (current.tree !== intent.tree || current.headRef !== intent.headRef) throw new Error("Git release tree or checked-out branch changed");
	if (report?.commit) {
		if (current.previousHead !== report.commit || git(root, ["status", "--porcelain", "--untracked-files=no"]))
			throw new Error("Git release commit changed or has tracked edits");
	} else if (current.previousHead !== intent.previousHead) {
		// Reconcile a commit that succeeded before its journal checkpoint was written.
		if (
			!intent.commitMessage ||
			git(root, ["show", "-s", "--format=%P", "HEAD"]) !== intent.previousHead ||
			git(root, ["show", "-s", "--format=%B", "HEAD"]) !== intent.commitMessage ||
			git(root, ["status", "--porcelain", "--untracked-files=no"])
		)
			throw new Error("Git release HEAD changed outside the reviewed commit");
	}
	const tagObject = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${intent.tag}`], { optional: true });
	const expected = report?.tagObject || intent.existingTagObject;
	if (expected && tagObject !== expected) throw new Error("Upgrade Git tag changed");
	if (tagObject) {
		if (git(root, ["rev-parse", `refs/tags/${intent.tag}^{commit}`]) !== current.previousHead)
			throw new Error("Upgrade Git tag targets another commit");
		if (
			!expected &&
			(git(root, ["cat-file", "-t", tagObject]) !== "tag" ||
				git(root, ["cat-file", "-p", tagObject])
					.split("\n\n")
					.slice(1)
					.join("\n\n")
					.split(/\n-----BEGIN (?:PGP|SSH) SIGNATURE-----/)[0]
					.trim() !== intent.annotation)
		)
			throw new Error("An unexpected local upgrade tag already exists");
	}
	return { commit: current.previousHead, tagObject };
}

async function networkGit(root, args) {
	const sink = taskOutputSink();
	sink?.line(`Git ${args[0]}: ${args[0] === "push" ? "publishing the selected tag" : "checking the selected remote tag"}`);
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{ cwd: root, encoding: "utf8", timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			(error, stdout) => {
				if (error) reject(new Error(`Git ${args[0]} failed or timed out; check remote access and retry to reconcile its outcome`));
				else resolve(stdout.trim());
			},
		);
		sink?.child(child);
	});
}

async function remoteTag(root, intent) {
	// The push URL may differ from the fetch URL. Never store or print the URL.
	const url = git(root, ["remote", "get-url", "--push", intent.remote]);
	const ref = `refs/tags/${intent.tag}`;
	const output = await networkGit(root, ["ls-remote", "--tags", "--", url, ref, `${ref}^{}`]);
	const refs = new Map(
		output
			.split("\n")
			.filter(Boolean)
			.map(line => line.split(/\s+/))
			.map(([hash, name]) => [name, hash]),
	);
	return { tagObject: refs.get(ref) || null, commit: refs.get(`${ref}^{}`) || refs.get(ref) || null };
}

export async function runGitReleasePhase(root, intent, file, phase) {
	const report = readReport(file, intent);
	const local = assertGitReleaseBinding(root, intent, report);
	if (phase === "inspect") {
		const remote = await remoteTag(root, intent);
		if (remote.tagObject && remote.tagObject !== local.tagObject)
			throw new Error("Remote upgrade tag already exists with a different object; choose another tag");
		report.inspected = true;
	} else if (phase === "commit") {
		if (!report.inspected) throw new Error("Review the Git release before committing");
		if (local.commit === intent.previousHead && intent.commitMessage) {
			writeReport(file, report);
			// Only the operator's exact staged tree is committed; no files are added here.
			git(root, ["commit", "-m", intent.commitMessage]);
		}
		report.commit = git(root, ["rev-parse", "HEAD"]);
		assertGitReleaseBinding(root, intent, report);
	} else if (phase === "tag") {
		if (!report.commit) throw new Error("Bind the release commit before tagging");
		if (!local.tagObject) {
			writeReport(file, report);
			git(root, ["tag", "-a", "-m", intent.annotation, "--", intent.tag, report.commit]);
		}
		report.tagObject = assertGitReleaseBinding(root, intent, report).tagObject;
	} else if (phase === "publish") {
		if (!report.commit || !report.tagObject) throw new Error("Bind the release commit and tag before publication");
		let remote = await remoteTag(root, intent);
		if (remote.tagObject && remote.tagObject !== report.tagObject) throw new Error("Remote upgrade tag changed; refusing to replace it");
		if (!remote.tagObject) {
			writeReport(file, report);
			const ref = `refs/tags/${intent.tag}`;
			await networkGit(root, ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", intent.remote, `${ref}:${ref}`]);
			remote = await remoteTag(root, intent);
		}
		if (remote.tagObject !== report.tagObject || remote.commit !== report.commit)
			throw new Error("Remote upgrade tag/commit verification failed");
		report.publication = { ...remote, remote: intent.remote, verifiedAt: new Date().toISOString() };
	} else throw new Error(`Unknown Git release phase ${phase}`);
	assertGitReleaseBinding(root, intent, report);
	writeReport(file, report);
	return report;
}

export function validateGitRelease(root, intent, file) {
	const report = readReport(file, intent);
	assertGitReleaseBinding(root, intent, report);
	return report;
}
