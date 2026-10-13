import { planSelectors, linkBytecode, matchRuntime, assertIntentTransaction, CUT_SELECTOR, LOUPE_SELECTOR } from "../server/model.js";
import { Interface } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const A = "0x1111111111111111111111111111111111111111",
	B = "0x2222222222222222222222222222222222222222";
const current = { "0x11111111": A, "0x22222222": A, [CUT_SELECTOR]: A, [LOUPE_SELECTOR]: A };
const candidate = { name: "Changed", address: B, selectors: { "0x11111111": "one()" } };
test("a selected facet patch preserves all omitted selectors", () => {
	const plan = planSelectors(current, [candidate]);
	assert.equal(plan.changes.length, 1);
	assert.equal(plan.finalMap["0x22222222"], A);
});
test("a no-op produces no changes", () => assert.equal(planSelectors(current, [{ ...candidate, address: A }]).changes.length, 0));
test("full reconciliation requires the exact removal set", () => {
	assert.throws(() => planSelectors(current, [candidate], { mode: "reconcile" }), /explicitly/);
	const plan = planSelectors(current, [candidate], { mode: "reconcile", removals: ["0x22222222"] });
	assert.equal(plan.finalMap["0x22222222"], undefined);
	assert.equal(plan.finalMap[CUT_SELECTOR], A);
});
test("collisions, contradictory actions and protected removals fail closed", () => {
	assert.throws(() => planSelectors(current, [candidate, { ...candidate, name: "Clash" }]), /collision/);
	assert.throws(() => planSelectors(current, [candidate], { removals: ["0x11111111"] }), /both/);
	assert.throws(() => planSelectors(current, [], { removals: [CUT_SELECTOR] }), /Cannot remove/);
});
test("runtime matching preserves metadata and resolves every library link exactly", () => {
	const references = { "Lib.sol": { Lib: [{ start: 1, length: 20 }] } };
	const template = `0x60${"_".repeat(40)}00`;
	const linked = linkBytecode(template, references, { Lib: A });
	assert.deepEqual(matchRuntime({ deployedBytecode: template, deployedLinkReferences: references }, linked), { "Lib.sol:Lib": A });
	assert.equal(matchRuntime({ deployedBytecode: template, deployedLinkReferences: references }, `${linked.slice(0, -2)}01`), null);
	assert.equal(matchRuntime({ deployedBytecode: linked, immutableReferences: { value: [{}] } }, linked), null);
});
test("wallet hash reconciliation binds the entire execution intent", () => {
	const request = { to: B, data: "0x1234", value: "0", nonce: 2, chainId: 42161 };
	const tx = { ...request, from: A };
	assert.doesNotThrow(() => assertIntentTransaction(tx, request, A));
	for (const change of [{ data: "0x1235" }, { from: B }, { chainId: 1 }, { nonce: 3 }, { value: "1" }, { to: A }])
		assert.throws(() => assertIntentTransaction({ ...tx, ...change }, request, A), /does not match/);
});

test("library self-address immutables are resolved exactly, never ignored", () => {
	const artifact = {
		kind: "library",
		deployedBytecode: `0x60${"00".repeat(32)}f3`,
		immutableReferences: { library_deploy_address: [{ start: 1, length: 32 }] },
	};
	const code = `0x60${A.slice(2).padStart(64, "0")}f3`;
	assert.deepEqual(matchRuntime(artifact, code, A), {});
	assert.equal(matchRuntime(artifact, code, B), null);
	assert.equal(matchRuntime(artifact, code), null);
});
