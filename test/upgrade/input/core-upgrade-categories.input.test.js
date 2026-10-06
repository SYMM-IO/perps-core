import { CUT_SELECTOR, planCoreCut } from "../../../deployment-tooling/arbitrum-core-upgrade.js";
import * as inputs from "../../../deployment-tooling/core-upgrade-input.js";
import { coreInputFixture } from "../helpers/core-upgrade-input.fixture.js";
import assert from "node:assert/strict";
import test from "node:test";

test("v1 and categorized v2 inputs retain the same upgrade policy, credentials and authority without rewriting saved input", () => {
	const legacy = coreInputFixture(1),
		categorized = coreInputFixture(2);
	for (const input of [legacy, categorized]) {
		const original = structuredClone(input);
		assert.equal(inputs.validateCoreUpgradeInput(input), input);
		assert.equal(inputs.isStandardCoreInput(input), true);
		assert.deepEqual(input, original);
	}
	assert.deepEqual(inputs.coreUpgradePolicies(legacy), inputs.coreUpgradePolicies(categorized));
	assert.deepEqual(inputs.coreUpgradeRecipe(legacy), inputs.coreUpgradeRecipe(categorized));
	assert.equal(inputs.coreUpgradeAuthority(legacy), inputs.coreUpgradeAuthority(categorized));
	assert.deepEqual(inputs.coreUpgradeNetwork(legacy), inputs.coreUpgradeNetwork(categorized));
});

test("v2 refuses missing categories, unsupported subjects, mixed formats and weakened compatibility rules", () => {
	for (const mutate of [
		x => delete x.storage.symbolAdjustment,
		x => (x.storage.accountLayer = x.storage.symbolAdjustment),
		x => (x.storage.legacyAdjustmentWords = 15),
		x => (x.storage.symbolAdjustment.legacyAdjustmentWords = 14),
		x => (x.storage.symbolAdjustment.upgradedAdjustmentWords = 18),
		x => (x.storage.symbolAdjustment.requireEmptyAdjustments = false),
		x => delete x.funding,
		x => delete x.funding.aggregate,
		x => (x.funding.legacy = { repair: true }),
		x => (x.funding.aggregate.repair = false),
		x => (x.repairAggregateFunding = true),
		x => delete x.selectors,
		x => delete x.selectors.core,
		x => (x.selectors.accountLayer = { allowedRemovals: [] }),
		x => (x.selectors.core.allowedRemovals = ["0xBAD"]),
		x => x.selectors.core.allowedRemovals.push(x.selectors.core.allowedRemovals[0]),
		x => (x.allowedRemovedSelectors = []),
		x => (x.apiVersion = "operations.symm.io/core-upgrade-input-v3"),
	]) {
		const input = coreInputFixture(2);
		mutate(input);
		assert.throws(() => inputs.validateCoreUpgradeInput(input), /Invalid Core upgrade input/);
	}
	for (const mutate of [
		x => (x.storage = { symbolAdjustment: x.storage }),
		x => (x.funding = { aggregate: { repair: true } }),
		x => (x.selectors = { core: { allowedRemovals: [] } }),
	]) {
		const input = coreInputFixture(1);
		mutate(input);
		assert.throws(() => inputs.validateCoreUpgradeInput(input), /Invalid Core upgrade input/);
	}
});

test("categorized selector policy still blocks an unreviewed removal and produces the same reviewed calldata as v1", () => {
	const address = digit => "0x" + digit.repeat(40);
	const baseline = { [CUT_SELECTOR]: address("1"), "0x12345678": address("2"), "0x23456789": address("2") };
	const facets = { replacement: { address: address("3"), selectors: ["0x23456789"] } };
	const legacy = inputs.validateCoreUpgradeInput(coreInputFixture(1));
	const categorized = inputs.validateCoreUpgradeInput(coreInputFixture(2));
	const plan = input => planCoreCut(baseline, baseline, facets, inputs.coreUpgradePolicies(input).selectors.core.allowedRemovals);
	assert.deepEqual(plan(categorized), plan(legacy));
	categorized.selectors.core.allowedRemovals = [];
	assert.throws(() => plan(categorized), /Unreviewed removed selectors: 0x12345678/);
});
