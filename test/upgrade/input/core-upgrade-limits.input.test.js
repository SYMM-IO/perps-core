import * as inputs from "../../../deployment-tooling/core-upgrade-input.js";
import { muonUpgradePolicy } from "../../../deployment-tooling/operations/muon-upgrade.js";
import { coreInputFixture } from "../helpers/core-upgrade-input.fixture.js";
import assert from "node:assert/strict";
import test from "node:test";

const categorized = () => {
	const input = coreInputFixture(2);
	input.limits = {
		coreSnapshot: { maxHistoricalQuotes: 10000, maxRegisteredSymbols: 1000 },
		signatureVerifierSnapshot: { maxRoleMembers: 7, maxSigners: 9 },
	};
	return input;
};

test("named snapshot limits preserve legacy Core and verifier scan behavior without rewriting the input", () => {
	const input = categorized(),
		original = structuredClone(input);
	inputs.validateCoreUpgradeInput(input);
	assert.deepEqual(inputs.coreUpgradeLimits(input), input.limits);
	for (const version of [1, 2]) {
		const legacy = coreInputFixture(version);
		legacy.muon = { maxRoleMembers: 7, maxSigners: 9 };
		inputs.validateCoreUpgradeInput(legacy);
		assert.deepEqual(inputs.coreUpgradeLimits(legacy), inputs.coreUpgradeLimits(input));
		assert.deepEqual(muonUpgradePolicy(inputs.coreUpgradeMuonPolicy(legacy)), muonUpgradePolicy(inputs.coreUpgradeMuonPolicy(input)));
		assert.deepEqual(inputs.coreUpgradeRecipe(legacy), inputs.coreUpgradeRecipe(input));
	}
	assert.deepEqual(input, original);
});

test("snapshot limits reject missing subjects, mixed formats, duplicate verifier policies and unsafe bounds", () => {
	for (const mutate of [
		x => delete x.limits.coreSnapshot,
		x => delete x.limits.coreSnapshot.maxHistoricalQuotes,
		x => delete x.limits.coreSnapshot.maxRegisteredSymbols,
		x => (x.limits.symbolManager = { maxSymbols: 1000 }),
		x => (x.limits.maxQuotes = 10000),
		x => (x.limits.coreSnapshot.maxHistoricalQuotes = 0),
		x => (x.limits.coreSnapshot.maxRegisteredSymbols = 1.5),
		x => (x.limits.coreSnapshot.maxHistoricalQuotes = Number.MAX_SAFE_INTEGER + 1),
		x => (x.limits.signatureVerifierSnapshot.maxSigners = 0),
		x => delete x.limits.signatureVerifierSnapshot.maxRoleMembers,
		x => (x.muon = { maxSigners: 9 }),
		x => (x.muon = { maxRoleMembers: 7 }),
	]) {
		const input = categorized();
		mutate(input);
		assert.throws(() => inputs.validateCoreUpgradeInput(input), /Invalid Core upgrade input|limits.signatureVerifierSnapshot/);
	}
	const v1 = coreInputFixture(1);
	v1.limits = categorized().limits;
	assert.throws(() => inputs.validateCoreUpgradeInput(v1), /Invalid Core upgrade input/);
	const defaults = categorized();
	delete defaults.limits.signatureVerifierSnapshot;
	assert.deepEqual(inputs.coreUpgradeLimits(defaults).signatureVerifierSnapshot, { maxRoleMembers: 100, maxSigners: 100 });
});

test("input review identifies every section's contract or workflow scope and runtime-supported logging", () => {
	const input = categorized();
	for (const logLevel of ["minimal", "verbose"]) {
		input.execution.logLevel = logLevel;
		assert.doesNotThrow(() => inputs.validateCoreUpgradeInput(input));
	}
	for (const logLevel of ["quiet", "normal", "silent"]) {
		input.execution.logLevel = logLevel;
		assert.throws(() => inputs.validateCoreUpgradeInput(input), /Invalid Core upgrade input/);
	}
	input.execution.logLevel = "verbose";
	const review = inputs.coreUpgradeInputReview(input) + "\n" + inputs.coreUpgradePolicyReview(input);
	for (const scope of [
		"network",
		"release.ref",
		"release.baselineRef",
		"credentials.deployer",
		"credentials.rpc",
		"credentials.explorer",
		"execution",
		"governance.owner",
		"governance.accountLayerOwner",
		"target.core",
		"target.symbolManager",
		"limits.coreSnapshot",
		"limits.signatureVerifierSnapshot",
		"muon.requiredFunctions",
		"muon.additionalVerifierRoles",
	])
		assert.ok(review.includes(scope), `Missing review scope: ${scope}`);
	assert.ok(review.includes("historical quotes"));
	assert.ok(review.includes("registered symbols"));
	assert.ok(review.includes(`Core (${input.target.core})`));
	assert.ok(review.includes(`Signature Verifier (${input.target.signatureVerifier})`));
});
