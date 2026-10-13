import { codeHash } from "../server/model.js";
import { identifyBuild, preparePlan } from "../server/planner.js";
import assert from "node:assert/strict";
import test from "node:test";

const facet = "0x1111111111111111111111111111111111111111";
const library = "0x2222222222222222222222222222222222222222";
const references = { "Lib.sol": { Lib: [{ start: 1, length: 20 }] } };
const before = { deployedBytecode: "0x600100", deployedLinkReferences: {}, dependencies: [], kind: "library" };
const artifact = {
	deployedBytecode: `0x60${"_".repeat(40)}00`,
	deployedLinkReferences: references,
	dependencies: ["Lib"],
	kind: "facet",
	selectors: { "0x11111111": "one()" },
};
const facetCode = `0x60${library.slice(2)}00`;
const snapshot = {
	blockNumber: 1,
	facets: [{ address: facet, code: facetCode }],
	map: { "0x11111111": facet },
	diamondCodeHash: codeHash("0x6000"),
	authority: { kind: "eoa" },
};
const baseline = { catalog: { Facet: artifact, Lib: before }, diamond: { deployedBytecode: "0x6000" }, storageSources: {} };
const provider = { getCode: async at => (at === library ? before.deployedBytecode : facetCode) };
test("changed linked library forces replacement of its dependent facet and preserves its baseline identity", async () => {
	assert.equal((await identifyBuild(snapshot, baseline, provider)).complete, true);
	const desired = { ...baseline, catalog: { ...baseline.catalog, Lib: { ...before, deployedBytecode: "0x600200" } } };
	assert.equal((await identifyBuild(snapshot, desired, provider)).complete, false);
	const plan = await preparePlan({
		snapshot,
		build: desired,
		baseline,
		selected: ["Facet"],
		mode: "patch",
		removals: [],
		deployer: facet,
		provider,
	});
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(
		plan.deployments.map(d => d.name),
		["Lib", "Facet"],
	);
	assert.equal(plan.changes[0].action, "replace");
	assert.equal(plan.supportingCode[library], codeHash(before.deployedBytecode));
});
