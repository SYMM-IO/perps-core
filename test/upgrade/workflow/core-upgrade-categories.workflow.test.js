import { validateCoreTaskInput } from "../../../cli/tasks/arbitrum-core-upgrade.js";
import { prepareStandardCoreUpgrade } from "../../../cli/tasks/core-upgrade.js";
import { digest } from "../../../deployment-tooling/arbitrum-core-upgrade.js";
import { coreInputFixture } from "../helpers/core-upgrade-input.fixture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const version of [1, 2]) {
	test(`v${version} preparation binds the original policy shape and continuation rejects category or policy drift`, async t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-category-binding-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const config = coreInputFixture(version);
		if (version === 2) config.roleGrants = { core: [{ holderRef: "target.symbolManager", role: "SYMBOL_LISTING_ROLE" }] };
		fs.mkdirSync(path.join(root, "tasks/config"), { recursive: true });
		fs.mkdirSync(path.join(root, "contracts"));
		fs.writeFileSync(path.join(root, "contracts/Test.sol"), "// reviewed source\n");
		fs.writeFileSync(path.join(root, ".gitignore"), "tasks/data/\n");
		const source = path.join(root, "tasks/config/core-upgrade.test.input.json");
		const write = input => fs.writeFileSync(source, JSON.stringify(input));
		write(config);
		const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		git(["init", "-q"]);
		git(["add", "contracts", "tasks/config", ".gitignore"]);
		git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "test: seed binding"]);
		for (const ref of [config.release.ref, config.release.baselineRef]) git(["tag", ref]);
		const input = await prepareStandardCoreUpgrade({ root, ui: { select: async () => source, note() {} } });
		const bound = validateCoreTaskInput({ root, state: {} }, input);
		assert.deepEqual(bound.config, config);
		assert.equal(bound.userInputDigest, digest(config));
		assert.equal(input.inputDigest, digest(bound));
		const changed = structuredClone(config);
		if (version === 2) changed.selectors.core.allowedRemovals = [];
		else changed.allowedRemovedSelectors = [];
		write(changed);
		assert.throws(() => validateCoreTaskInput({ root, state: {} }, input), /Original upgrade input changed/);
		write(config);
		assert.deepEqual(validateCoreTaskInput({ root, state: {} }, input), bound);
		if (version === 2) {
			const changedGrant = structuredClone(config);
			changedGrant.roleGrants.core[0].holderRef = "governance.owner";
			write(changedGrant);
			assert.throws(() => validateCoreTaskInput({ root, state: {} }, input), /Original upgrade input changed/);
			write(config);
			assert.deepEqual(validateCoreTaskInput({ root, state: {} }, input), bound);
			changed.storage.unknownSubject = changed.storage.symbolAdjustment;
			write(changed);
			assert.throws(() => validateCoreTaskInput({ root, state: {} }, input), /Original upgrade input changed/);
		}
	});
}
