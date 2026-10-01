import {
	ACCOUNT_FACETS,
	POLICY,
	digest,
	planAccountCut,
	validateUpgradeConfig,
	assertConfigurationParity,
	flowDiscovery,
	upgradeRequiresForkRehearsal,
	createUpgradeRehearsalWaiver,
	assertUpgradeRehearsal,
} from "../../deployment-tooling/account-instant-upgrade.js";
import { Interface, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const address = n => `0x${n.toString(16).padStart(40, "0")}`;
function config() {
	return {
		apiVersion: "operations.symm.io/account-instant-upgrade-v1",
		chainId: 42161,
		target: {
			core: address(1),
			collateral: address(2),
			accountLayer: address(3),
			instantLayer: address(4),
			gaslessLayer: address(5),
			safe: address(6),
			relayer: address(9),
			partyBAdmins: { [address(7)]: address(6) },
		},
		gaslessBaselineCommit: "a".repeat(40),
		policy: { ...POLICY },
		discovery: { mode: "flow", gaslessSelectors: [], instantTargets: [address(1), address(3)], instantPartyBs: [address(7)] },
	};
}
test("upgrade preserves proxies and configuration and refuses user-state or timelock-setting scope", () => {
	assert.deepEqual(validateUpgradeConfig(config()).policy, POLICY);
	for (const key of Object.keys(POLICY)) {
		const changed = config();
		changed.policy[key] = !changed.policy[key];
		assert.throws(() => validateUpgradeConfig(changed), /policy/);
	}
	const changed = config();
	changed.target.gaslessLayer = ZeroAddress;
	assert.throws(() => validateUpgradeConfig(changed), /gaslessLayer/);
	assert.throws(() => validateUpgradeConfig({ ...config(), secret: "anything" }), /Unknown/);
});
test("configuration comparison includes false, zero, relayers, template IDs and insertion offsets", () => {
	const before = { gasless: { fee: "0", block: false, relayers: [address(8)] }, instant: { templates: [{ id: 12, active: true, offset: "480" }] } };
	assert.doesNotThrow(() => assertConfigurationParity(before, structuredClone(before)));
	for (const mutate of [
		x => (x.gasless.fee = "1"),
		x => (x.gasless.block = true),
		x => (x.gasless.relayers = []),
		x => (x.instant.templates[0].offset = "448"),
	]) {
		const after = structuredClone(before);
		mutate(after);
		assert.throws(() => assertConfigurationParity(before, after), /Configuration drift/);
	}
	assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
test("fork rehearsal is required by default and only an explicit boolean can waive it", () => {
	assert.equal(upgradeRequiresForkRehearsal(config()), true);
	for (const required of [true, false])
		assert.equal(upgradeRequiresForkRehearsal({ ...config(), execution: { requireForkRehearsal: required } }), required);
	for (const execution of [
		null,
		{},
		{ requireForkRehearsal: "false" },
		{ requireForkRehearsal: 0 },
		{ requireForkRehearsal: false, skipChecks: true },
	])
		assert.throws(() => validateUpgradeConfig({ ...config(), execution }), /execution/);
});
test("deployment requires matching rehearsal evidence or a waiver bound to the exact input, source and live snapshot", () => {
	const input = { config: { ...config(), execution: { requireForkRehearsal: false } }, sourceCommit: "b".repeat(40) };
	const snapshot = { blockNumber: 1234, gasless: { depositFee: "0" } };
	const report = { snapshotDigest: digest(snapshot), snapshotBlock: snapshot.blockNumber };
	assert.throws(() => assertUpgradeRehearsal(input, report), /snapshot/);
	report.rehearsal = createUpgradeRehearsalWaiver(input, snapshot, "2026-09-13T00:00:00.000Z");
	assert.equal(report.rehearsal.status, "skipped");
	assert.doesNotThrow(() => assertUpgradeRehearsal(input, report));
	for (const [key, value] of [
		["snapshotDigest", "different"],
		["snapshotBlock", 1235],
		["inputDigest", "different"],
		["sourceCommit", "c".repeat(40)],
		["reason", ""],
		["skippedAt", "invalid"],
		["status", "failed"],
	]) {
		const changed = structuredClone(report);
		changed.rehearsal[key] = value;
		assert.throws(() => assertUpgradeRehearsal(input, changed), /rehearsal/);
	}
	const changedInput = structuredClone(input);
	changedInput.config.target.relayer = address(42);
	assert.throws(() => assertUpgradeRehearsal(changedInput, report), /rehearsal/);
	assert.throws(() => createUpgradeRehearsalWaiver(input, { blockNumber: 0 }), /snapshot block/);
	delete input.config.execution;
	assert.throws(() => createUpgradeRehearsalWaiver(input, snapshot), /requires fork rehearsal/);
	assert.throws(() => assertUpgradeRehearsal(input, report), /rehearsal/);
	report.rehearsal = { status: "complete", snapshotDigest: report.snapshotDigest };
	assert.doesNotThrow(() => assertUpgradeRehearsal(input, report));
	report.rehearsal.snapshotDigest = "different";
	assert.throws(() => assertUpgradeRehearsal(input, report), /snapshot/);
});
test("flow discovery binds supplied actors without requiring complete holder lists or event history", () => {
	const value = config();
	assert.deepEqual(validateUpgradeConfig(value), value);
	assert.deepEqual(flowDiscovery(value).gaslessRoleMembers, [address(6), address(9)]);
	assert.deepEqual(flowDiscovery(value).instantRoleMembers, [address(5), address(6), address(7)]);
	for (const mutate of [
		x => delete x.target.relayer,
		x => delete x.discovery.gaslessSelectors,
		x => (x.discovery.mode = "events"),
		x => (x.discovery.instantPartyBs = [address(99)]),
		x => (x.discovery.gaslessSelectors = ["0x1234"]),
		x => (x.target.partyBAdmins[address(7)] = address(8)),
	]) {
		const changed = config();
		mutate(changed);
		assert.throws(() => validateUpgradeConfig(changed));
	}
});
function cutFixture() {
	const baseline = { "0x99999999": address(99) },
		facets = {};
	for (const [i, name] of ACCOUNT_FACETS.entries()) {
		const selector = `0x${(i + 1).toString(16).padStart(8, "0")}`;
		facets[name] = { address: address(i + 20), selectors: [selector] };
		if (name !== "TimelockFacet") baseline[selector] = address(i + 10);
	}
	return { baseline, facets };
}
test("AccountLayer cut adds timelocks, replaces only selected facets, preserves other selectors and resumes partially", () => {
	const { baseline, facets } = cutFixture();
	const result = planAccountCut(baseline, baseline, facets);
	assert.equal(result.desired["0x99999999"], address(99));
	assert.equal(result.cut.filter(x => x.action === 0).length, 1);
	assert.equal(result.cut.filter(x => x.action === 1).length, 4);
	const decoded = new Interface([
		"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[],address,bytes)",
	]).decodeFunctionData("diamondCut", result.calldata);
	assert.equal(decoded[1], ZeroAddress);
	assert.equal(decoded[2], "0x");
	assert.deepEqual(planAccountCut(baseline, result.desired, facets).cut, []);
	const partial = { ...baseline, "0x00000001": facets.CoreFacet.address };
	assert.equal(planAccountCut(baseline, partial, facets).cut.length, result.cut.length - 1);
	assert.throws(() => planAccountCut(baseline, { ...baseline, "0x99999999": address(98) }, facets), /Selector drift/);
	assert.throws(() => planAccountCut(baseline, { ...baseline, "0x88888888": address(98) }, facets), /Selector drift/);
});
test("AccountLayer cut refuses omitted old selectors, collisions, and partial facet selection", () => {
	const { baseline, facets } = cutFixture();
	assert.throws(() => planAccountCut({ ...baseline, "0x77777777": baseline["0x00000001"] }, baseline, facets), /omit/);
	const missing = { ...facets };
	delete missing.MarginFacet;
	assert.throws(() => planAccountCut(baseline, baseline, missing), /Exactly/);
	facets.TimelockFacet.selectors = facets.CoreFacet.selectors;
	assert.throws(() => planAccountCut(baseline, baseline, facets), /collision/);
});
