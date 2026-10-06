import { digest } from "./account-instant-upgrade.js";
import { isStandardCoreInput } from "./core-upgrade-input.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function assertCoreUpgradeSourceBinding(root, input) {
	if (!isStandardCoreInput(input.config)) return;
	if (input.apiVersion !== "operations.symm.io/core-upgrade-run-v1") throw new Error("Standard Core input requires its standard run API");
	if (digest(JSON.parse(fs.readFileSync(input.inputSource, "utf8"))) !== input.userInputDigest || digest(input.config) !== input.userInputDigest)
		throw new Error("Original upgrade input changed");
	const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	if (git(["rev-parse", "HEAD"]) !== input.sourceCommit || git(["status", "--porcelain", "--untracked-files=no"]))
		throw new Error("Core upgrade source changed or has tracked edits");
	if (input.upgradeGitTag) {
		const release = input.upgradeGitTag;
		if (
			release.commit !== (release.targetRef ? input.releaseCommit : input.sourceCommit) ||
			(release.targetRef && git(["rev-parse", "--verify", "--end-of-options", `${release.targetRef}^{commit}`]) !== input.releaseCommit) ||
			release.publication?.commit !== release.commit ||
			release.publication?.tagObject !== release.tagObject ||
			git(["rev-parse", "--verify", "--end-of-options", `refs/tags/${release.tag}`]) !== release.tagObject ||
			git(["rev-parse", "--verify", "--end-of-options", `refs/tags/${release.tag}^{commit}`]) !== release.commit
		)
			throw new Error("Published upgrade Git tag binding changed");
	}
	for (const [ref, commit] of [
		[input.config.release.ref, input.releaseCommit],
		[input.config.release.baselineRef, input.baselineCommit],
	])
		if (git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]) !== commit)
			throw new Error("Core upgrade release or baseline reference changed");
	if (
		git(["rev-parse", `${input.releaseCommit}:contracts`]) !== input.contractsTree ||
		git(["rev-parse", "HEAD:contracts"]) !== input.contractsTree
	)
		throw new Error("Current Solidity differs from the bound release");
}
