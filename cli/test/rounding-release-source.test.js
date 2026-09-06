import {
	assertReleaseSource,
	buildRoundingInput,
	RECIPE_PATH,
	RELEASE_TAG,
	TARGET_PATH,
	ROUNDING_PROFILES,
	requiresRoundingPause,
} from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
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
	const profile = ROUNDING_PROFILES.production;
	const target = JSON.parse(fs.readFileSync(path.join(fixture.root, TARGET_PATH)));
	target.core = "0x2222222222222222222222222222222222222222";
	target.owner = target.safe;
	target.governanceMode = "ledger";
	delete target.safe;
	const recipe = JSON.parse(fs.readFileSync(path.join(fixture.root, RECIPE_PATH)));
	recipe.name = profile.recipeName;
	fixture.write(profile.targetPath, JSON.stringify(target));
	fixture.write(profile.recipePath, JSON.stringify(recipe));
	fixture.commit([profile.targetPath, profile.recipePath]);
	const stage = buildRoundingInput(fixture.root);
	const production = buildRoundingInput(fixture.root, "production");
	assert.equal(production.profile, "production");
	assert.equal(production.apiVersion, "operations.symm.io/arbitrum-rounding-upgrade-v4");
	assert.equal(production.releaseCommit, stage.releaseCommit);
	assert.notEqual(production.targetDigest, stage.targetDigest);
	assert.notEqual(production.recipeDigest, stage.recipeDigest);
	assert.equal(requiresRoundingPause(production), true);
	assert.equal(requiresRoundingPause(stage), false);
	assert.doesNotThrow(() => assertReleaseSource(fixture.root, production));
	assert.throws(() => assertReleaseSource(fixture.root, { ...production, profile: "stage" }), /changed since preparation/);
	assert.throws(() => assertReleaseSource(fixture.root, { ...production, apiVersion: stage.apiVersion }), /differs from the release target/);
	assert.throws(() => buildRoundingInput(fixture.root, "unknown"), /Unknown rounding upgrade profile/);
	fixture.write(profile.recipePath, JSON.stringify({ ...recipe, governance: { admin: target.core } }));
	fixture.commit([profile.recipePath]);
	assert.throws(() => buildRoundingInput(fixture.root, "production"), /reviewed Core owner/);
});
