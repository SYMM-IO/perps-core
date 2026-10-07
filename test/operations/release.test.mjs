import { releaseSucceeded, RELEASE_GROUPS, runCandidate, EXCLUSION_CANARIES } from "../../scripts/release-candidate.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("every isolated candidate gate is required; a missing/failed image cannot pass", () => {
	const results = ["image", "image-policy", ...RELEASE_GROUPS.map(group => group.id), "artifacts", "image-metadata", "fuzz-evidence"].map(id => ({
		id,
		status: "passed",
	}));
	assert.equal(releaseSucceeded(results), true);
	for (const item of results) {
		assert.equal(releaseSucceeded(results.filter(result => result !== item)), false);
		assert.equal(releaseSucceeded(results.map(result => (result === item ? { ...result, status: "failed" } : result))), false);
	}
	assert.equal(releaseSucceeded([...results, results[0]]), false);
});

test("isolated job archives every group/failure under the candidate identity without passing credentials", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-rc-fixture-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repository = path.join(root, "repository");
	fs.mkdirSync(repository);
	for (const [file, contents] of Object.entries({
		"package.json": "{}",
		"package-lock.json": "{}",
		"hardhat.config.ts": "export default {}",
		Dockerfile: "fixture",
		".node-version": "22.15.0",
	}))
		fs.writeFileSync(path.join(repository, file), contents);
	fs.mkdirSync(path.join(repository, "deployment-recipes"));
	fs.copyFileSync("deployment-recipes/localhost.json", path.join(repository, "deployment-recipes", "localhost.json"));
	const git = args => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
	git(["init", "-q"]);
	git(["add", "."]);
	git([
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"-c",
		"commit.gpgSign=false",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-qm",
		"candidate fixture",
	]);
	const commit = git(["rev-parse", "HEAD"]);
	const groups = [];
	const execute = (binary, args, options) => {
		if (binary !== "docker") return spawnSync(binary, args, options);
		assert.ok(Object.keys(options.env).every(key => !/RPC|PRIVATE|SIGNER|KEYSTORE|TOKEN|SECRET|PROXY/i.test(key)));
		if (args[0] === "run") {
			assert.ok(args.includes("none"), "check container disables networking");
			if (args.includes("image-policy")) throw new Error("policy passed as wrong argument");
			if (args.at(-2) === "run") {
				const mount = args[args.indexOf("--mount") + 1];
				assert.match(mount, /target=\/app\/symmio\/deployment-recipes,readonly$/);
				const fixtures = mount.match(/source=(.*),target=/)[1];
				assert.deepEqual(fs.readdirSync(fixtures), ["localhost.json"]);
				groups.push(args.at(-1));
				assert.ok(args.includes("FUZZ_SEED=fixture-seed"));
				fs.writeSync(options.stdio[1], `synthetic ${args.at(-1)} evidence\n`);
				return { status: args.at(-1) === "check:operations" ? 1 : 0 };
			}
			fs.writeSync(options.stdio[1], JSON.stringify({ node: "22.15.0", npm: "fixture", uid: 1000 }));
		}
		if (args[0] === "cp") {
			fs.mkdirSync(args[2], { recursive: true });
			fs.writeFileSync(path.join(args[2], "fixture.json"), "{}");
		}
		return { status: 0 };
	};
	const output = path.join(root, "failed-evidence");
	const result = await runCandidate(commit, output, { repository, execute, seed: "fixture-seed", rootActions: 5 });
	assert.equal(result.status, "failed");
	assert.deepEqual(
		groups,
		RELEASE_GROUPS.map(group => group.script),
	);
	assert.equal(result.commit, commit);
	assert.match(result.inputs.lockHash, /^sha256:/);
	assert.equal(result.inputs.recipeFixtures[0].path, "deployment-recipes/localhost.json");
	assert.match(fs.readFileSync(path.join(output, "operations.log"), "utf8"), /synthetic check:operations evidence/);
	const persisted = JSON.parse(fs.readFileSync(path.join(output, "result.json")));
	assert.equal(persisted.status, "failed");
	assert.equal(persisted.results.find(item => item.id === "documentation").status, "passed");
	assert.equal(JSON.parse(fs.readFileSync(path.join(output, "artifact-manifest.json"))).commit, commit);
	await assert.rejects(runCandidate(commit, output, { repository, execute }), /exist/i);
});
test("candidate inputs refuse moving refs and unbounded fuzz before any build", async () => {
	await assert.rejects(runCandidate("version_0.8.6", "unused"), /immutable/);
	await assert.rejects(runCandidate("a".repeat(40), "unused", { rootActions: 0 }), /bounded/);
});
test("image builds from a locked non-root stage after complete source import closure", () => {
	const dockerfile = fs.readFileSync("Dockerfile", "utf8");
	assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7\.1@sha256:[a-f0-9]{64}/);
	assert.match(dockerfile, /FROM node:22\.15\.0-bookworm@sha256:[a-f0-9]{64}/);
	assert.match(dockerfile, /COPY .*package\.json package-lock\.json/);
	assert.match(dockerfile, /npm ci --ignore-scripts/);
	assert.doesNotMatch(dockerfile, /npm install|npx|COPY .*\.env/);
	assert.ok(dockerfile.indexOf("COPY --chown=node:node . .") < dockerfile.indexOf("cli.js compile"));
	assert.match(dockerfile, /USER node/);
	assert.match(dockerfile, /org.opencontainers.image.revision/);
	const ignore = fs.readFileSync(".dockerignore", "utf8");
	assert.match(ignore, /^\*\*$/m);
	assert.match(ignore, /!deployment-tooling\/\*\*/);
	assert.match(ignore, /tasks\/data\/\*\*/);
	assert.match(ignore, /\*\*\/\.env\.\*/);
	assert.ok(EXCLUSION_CANARIES.includes(".env.production"));
});
