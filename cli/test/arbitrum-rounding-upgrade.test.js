import { assertRoundingFactoryIntent, FACETS, GETTER, planRoundingCut } from "../../deployment-tooling/arbitrum-rounding-upgrade.js";
import { createSafeBatch, validateSafeBatchTransport } from "../signer/safe-batch.js";
import { createArbitrumRoundingUpgradeTask, ROUNDING_PLAN } from "../tasks/arbitrum-rounding-upgrade.js";
import { Interface, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

function fixture() {
	const baseline = { "0x12345678": "0x1111111111111111111111111111111111111111" };
	const facets = {},
		oldFacets = {};
	for (const [i, name] of FACETS.entries()) {
		const old = "0x" + String(i + 2).repeat(40);
		const selector = "0x" + String(i + 2).repeat(8);
		oldFacets[name] = { address: old };
		baseline[selector] = old;
		facets[name] = { address: "0x" + String(i + 6).repeat(37) + "862", selectors: [selector, ...(name === "ViewFacet" ? [GETTER] : [])] };
	}
	return { baseline, facets, oldFacets };
}

test("rounding cut changes exactly four facets plus the new getter and preserves unrelated selectors", () => {
	const { baseline, facets, oldFacets } = fixture();
	const result = planRoundingCut(baseline, baseline, facets, oldFacets);
	assert.equal(result.desired["0x12345678"], baseline["0x12345678"]);
	assert.equal(
		result.cut.reduce((n, group) => n + group.functionSelectors.length, 0),
		5,
	);
	assert.equal(result.cut.filter(group => group.action === 0).length, 1);
	assert.equal(
		result.cut.some(group => group.action === 2),
		false,
	);
	const iface = new Interface([
		"function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] cut,address init,bytes data)",
	]);
	const decoded = iface.decodeFunctionData("diamondCut", result.calldata);
	assert.equal(decoded.init, ZeroAddress);
	assert.equal(decoded.data, "0x");
	assert.deepEqual(planRoundingCut(baseline, result.desired, facets, oldFacets).cut, []);
	const batch = createSafeBatch({
		chainId: 42161,
		safeAddress: "0x1111111111111111111111111111111111111111",
		name: "rounding",
		actions: [{ to: "0x2222222222222222222222222222222222222222", value: "0", data: result.calldata, description: "Core rounding cut" }],
	});
	validateSafeBatchTransport(batch);
	assert.equal(batch.transactionBuilder.transactions[0].data, result.calldata.toLowerCase());
});

test("rounding cut refuses unrelated or partial concurrent selector changes", () => {
	const { baseline, facets, oldFacets } = fixture();
	assert.throws(() => planRoundingCut(baseline, { ...baseline, "0x12345678": facets.ViewFacet.address }, facets, oldFacets), /changed outside/);
	assert.throws(() => planRoundingCut(baseline, { ...baseline, "0x99999999": oldFacets.ViewFacet.address }, facets, oldFacets), /changed outside/);
	facets.ViewFacet.selectors.push("0x12345678");
	assert.throws(() => planRoundingCut(baseline, baseline, facets, oldFacets), /outside the reviewed/);
});

test("rounding cut enforces suffix, exact scope, and the new getter", () => {
	const { baseline, facets, oldFacets } = fixture();
	const wrongSuffix = structuredClone(facets);
	wrongSuffix.ViewFacet.address = oldFacets.ViewFacet.address;
	assert.throws(() => planRoundingCut(baseline, baseline, wrongSuffix, oldFacets), /does not end in 862/);
	const missing = structuredClone(facets);
	delete missing.ClearingHouseFacet;
	assert.throws(() => planRoundingCut(baseline, baseline, missing, oldFacets), /Exactly four/);
	facets.ViewFacet.selectors = facets.ViewFacet.selectors.filter(s => s !== GETTER);
	assert.throws(() => planRoundingCut(baseline, baseline, facets, oldFacets), /new rounding getter/);
});

test("operator flow rehearses before authorizing deployment and ends with on-chain verification", () => {
	const ids = ROUNDING_PLAN.map(step => step.id);
	assert(ids.indexOf("rehearse") < ids.indexOf("authorize"));
	assert(ids.indexOf("authorize") < ids.indexOf("deploy"));
	assert(ids.indexOf("publish") < ids.indexOf("core-cut"));
	assert.equal(ids.at(-1), "verify");
	assert.equal(
		ids.some(id => /account|instant|gasless/.test(id)),
		false,
	);
});

test("temporary factory intent rejects the inaccessible reused factory and accepts the operator wallet", () => {
	assert.doesNotThrow(() => assertRoundingFactoryIntent({ factory: { mode: "deploy" } }));
	assert.throws(
		() => assertRoundingFactoryIntent({ factory: { mode: "reuse", address: "0x99B425BC19F99a1B922664c0E4fa8A0870CE9975" } }),
		/new temporary/,
	);
	assert.throws(() => assertRoundingFactoryIntent({ factory: { mode: "deploy", address: ZeroAddress } }), /new temporary/);
	const task = createArbitrumRoundingUpgradeTask(value => value);
	assert.equal(task.signerPolicy({}).expectedAddress, undefined);
	assert(task.version > 2);
	assert.match(ROUNDING_PLAN.find(step => step.id === "authorize").title, /nine/);
});
