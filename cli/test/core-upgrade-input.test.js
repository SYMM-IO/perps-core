import {
	validateCoreUpgradeInput,
	coreUpgradeRecipe,
	coreUpgradeAuthority,
	coreUpgradeNetwork,
} from "../../deployment-tooling/core-upgrade-input.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const fixture = () => JSON.parse(fs.readFileSync("tasks/config/core-upgrade.arbitrum-vibe-production.input.json"));
test("standard Core input binds every deployment value and derives live/fork credential recipes", () => {
	const input = validateCoreUpgradeInput(fixture());
	assert.equal(coreUpgradeAuthority(input), input.governance.owner);
	assert.equal(coreUpgradeNetwork(input).chainId, input.network.chainId);
	assert.equal(coreUpgradeRecipe(input).network.name, input.network.name);
	assert.equal(coreUpgradeRecipe(input, true).network.name, input.network.fork);
	assert.deepEqual(coreUpgradeRecipe(input).secrets, input.credentials);
});
test("another deployment and supported chain require only a different standard input", () => {
	const input = fixture();
	input.name = "base-example";
	input.network = { name: "base", chainId: 8453, fork: "fork-base" };
	input.governance.owner = "0x" + "12".repeat(20);
	input.target.core = "0x" + "34".repeat(20);
	assert.doesNotThrow(() => validateCoreUpgradeInput(input));
	assert.doesNotThrow(() =>
		validateCoreUpgradeInput(JSON.parse(fs.readFileSync("deployment-tooling/examples/core-upgrade.base-example.input.json"))),
	);
});
test("input refuses ambiguous authority, unsupported layouts, secret values, unknown fields and incomplete scans", () => {
	for (const mutate of [
		x => (x.extra = true),
		x => (x.target.safe = x.governance.owner),
		x => (x.network.chainId = 1),
		x => (x.network.fork = "fork-base"),
		x => (x.credentials.rpc = "https://private.example/rpc"),
		x => (x.credentials.deployer = "0x" + "11".repeat(32)),
		x => (x.limits.maxQuotes = 0),
		x => (x.storage.legacyAdjustmentWords = 17),
		x => (x.governance.kind = "unknown"),
		x => (x.governance.signerMode = "local-node"),
		x => (x.roleGrants[0].role = "misspelled"),
		x => x.roleGrants.push(x.roleGrants[0]),
		x => (x.allowedRemovedSelectors = ["0xBAD"]),
		x => (x.release.ref = ""),
		x => delete x.release.baselineRef,
		x => delete x.governance.ledgerDerivation,
	]) {
		const input = fixture();
		mutate(input);
		assert.throws(() => validateCoreUpgradeInput(input));
	}
});
