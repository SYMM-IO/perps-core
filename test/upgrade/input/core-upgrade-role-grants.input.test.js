import * as inputs from "../../../deployment-tooling/core-upgrade-input.js";
import { coreInputFixture } from "../helpers/core-upgrade-input.fixture.js";
import assert from "node:assert/strict";
import test from "node:test";

const categorized = () => {
	const input = coreInputFixture(2);
	input.roleGrants = {
		core: [
			{ holderRef: "target.symbolManager", role: "SYMBOL_LISTING_ROLE" },
			{ holderRef: "governance.owner", role: "GLOBAL_PAUSER_ROLE" },
			{ holder: "0x" + "3".repeat(40), role: "PARTY_A_PAUSER_ROLE" },
		],
	};
	return input;
};

test("categorized Core grants resolve named recipients without changing the digest-bound input", () => {
	const input = categorized(),
		original = structuredClone(input);
	assert.equal(inputs.validateCoreUpgradeInput(input), input);
	assert.deepEqual(inputs.coreUpgradeRoleGrants(input), [
		{ holderRef: "target.symbolManager", holder: input.target.symbolManager, role: "SYMBOL_LISTING_ROLE" },
		{ holderRef: "governance.owner", holder: input.governance.owner, role: "GLOBAL_PAUSER_ROLE" },
		{ holder: "0x" + "3".repeat(40), role: "PARTY_A_PAUSER_ROLE" },
	]);
	assert.deepEqual(input, original);
	const review = inputs.coreUpgradeRoleGrantReview(input);
	assert.ok(review.includes(`Core (${input.target.core})`));
	for (const grant of inputs.coreUpgradeRoleGrants(input)) {
		assert.ok(review.includes(grant.role));
		assert.ok(review.toLowerCase().includes(grant.holder.toLowerCase()));
		if (grant.holderRef) assert.ok(review.includes(grant.holderRef));
	}
});

test("existing v1 and v2 flat role lists retain their original recipients and input shape", () => {
	for (const version of [1, 2]) {
		const input = coreInputFixture(version);
		input.roleGrants = [{ holder: input.target.symbolManager, role: "SYMBOL_LISTING_ROLE" }];
		const original = structuredClone(input);
		inputs.validateCoreUpgradeInput(input);
		assert.deepEqual(inputs.coreUpgradeRoleGrants(input), original.roleGrants);
		assert.deepEqual(input, original);
	}
});

test("grant categories reject unsupported contracts, ambiguous recipients and duplicate resolved grants", () => {
	for (const mutate of [
		x => (x.roleGrants.accountLayer = x.roleGrants.core),
		x => delete x.roleGrants.core,
		x => (x.roleGrants.core[0].holderRef = "target.accountLayer"),
		x => (x.roleGrants.core[0].holderRef = "governance.missingOwner"),
		x => (x.roleGrants.core[0].holder = x.target.symbolManager),
		x => delete x.roleGrants.core[0].holderRef,
		x => (x.roleGrants.core[0].role = "misspelled"),
		x => (x.roleGrants.core[2].holder = "0x" + "0".repeat(40)),
		x => x.roleGrants.core.push({ holder: x.target.symbolManager, role: "SYMBOL_LISTING_ROLE" }),
		x => x.roleGrants.core.push({ holderRef: "governance.owner", role: "MIGRATION_ROLE" }),
	]) {
		const input = categorized();
		mutate(input);
		assert.throws(
			() => inputs.validateCoreUpgradeInput(input),
			/Invalid Core upgrade input|Zero role holder|Duplicate role grant|migration role/,
		);
	}
	const v1 = categorized();
	v1.apiVersion = inputs.CORE_INPUT_API;
	// Keep all other v1 fields valid so the failure proves the category boundary.
	const originalV1 = coreInputFixture(1);
	originalV1.roleGrants = v1.roleGrants;
	assert.throws(() => inputs.validateCoreUpgradeInput(originalV1), /Invalid Core upgrade input/);
});
