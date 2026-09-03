import {
	ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION,
	ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION,
	ARBITRUM_PERPS_UPGRADE_TARGET,
	arbitrumPerpsUpgradeInputDigest,
	buildArbitrumPerpsUpgradeInput,
	createArbitrumPerpsUpgradeReport,
	validateArbitrumPerpsUpgradeInput,
	validateArbitrumPerpsUpgradeReport,
} from "../../deployment-tooling/arbitrum-perps-upgrade.js";
import { loadDeploymentRecipe } from "../../deployment-tooling/recipe.js";
import assert from "node:assert/strict";
import test from "node:test";

function input() {
	const loaded = loadDeploymentRecipe("deployment-recipes/arbitrum-vibe-production.json");
	return buildArbitrumPerpsUpgradeInput({
		recipe: loaded.recipe,
		recipePath: loaded.identityPath,
		recipeDigest: loaded.digest,
		sourceCommit: "a".repeat(40),
	});
}

test("Arbitrum upgrade input is a fixed, digest-bound standard document", () => {
	const value = input();
	assert.equal(value.apiVersion, ARBITRUM_PERPS_UPGRADE_INPUT_API_VERSION);
	assert.equal(value.governance.safe, ARBITRUM_PERPS_UPGRADE_TARGET.safe);
	assert.equal(value.contracts.core, ARBITRUM_PERPS_UPGRADE_TARGET.contracts.core);
	assert.equal(value.instantLayer.mode, "deploy");
	assert.equal(value.gaslessLayer.mode, "deploy");
	assert.equal(value.execution.requireForkRehearsal, true);
	assert.match(arbitrumPerpsUpgradeInputDigest(value), /^[0-9a-f]{64}$/);
	assert.equal(arbitrumPerpsUpgradeInputDigest(value), arbitrumPerpsUpgradeInputDigest(structuredClone(value)));
});

test("Arbitrum upgrade input refuses target, authority, source, and live-safety drift", () => {
	for (const mutate of [
		value => (value.contracts.core = "0x1111111111111111111111111111111111111111"),
		value => (value.governance.safe = "0x2222222222222222222222222222222222222222"),
		value => (value.source.commit = "not-a-commit"),
		value => (value.execution.verify = false),
		value => (value.execution.requireForkRehearsal = "no"),
	]) {
		const changed = structuredClone(input());
		mutate(changed);
		assert.throws(() => validateArbitrumPerpsUpgradeInput(changed), /must/);
	}
});

test("Arbitrum upgrade input digest binds an explicit fork rehearsal waiver", () => {
	const required = input();
	const loaded = loadDeploymentRecipe("deployment-recipes/arbitrum-vibe-production.json");
	const waived = buildArbitrumPerpsUpgradeInput({
		recipe: loaded.recipe,
		recipePath: loaded.identityPath,
		recipeDigest: loaded.digest,
		sourceCommit: "a".repeat(40),
		requireForkRehearsal: false,
	});
	assert.equal(waived.execution.requireForkRehearsal, false);
	assert.notEqual(arbitrumPerpsUpgradeInputDigest(waived), arbitrumPerpsUpgradeInputDigest(required));
});

test("Arbitrum upgrade report binds every resumable update to the exact input", () => {
	const value = input();
	const report = createArbitrumPerpsUpgradeReport(value, "2026-09-02T00:00:00.000Z");
	assert.equal(report.apiVersion, ARBITRUM_PERPS_UPGRADE_REPORT_API_VERSION);
	assert.equal(report.lifecycle, "prepared");
	assert.equal(report.addresses.newInstantLayer, null);
	assert.equal(validateArbitrumPerpsUpgradeReport(report, value), report);
	const changed = structuredClone(value);
	changed.source.commit = "b".repeat(40);
	assert.throws(() => validateArbitrumPerpsUpgradeReport(report, changed), /inputDigest must equal/);
});
