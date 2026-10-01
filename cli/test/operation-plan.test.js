import { buildCorePlan, captureCoreSnapshot } from "../../deployment-tooling/operations/core-plan.js";
import { loadOperation, operationDigest } from "../../deployment-tooling/operations/inputs.js";
import { operationFixture, operationAddress as address, operationHash as hash } from "./fixtures/operation.js";
import { Interface, keccak256 } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const iface = new Interface(["function foo()", "function bar()"]);
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "operation-plan-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const f = operationFixture(root),
		bundle = loadOperation(f.file);
	const snapshot = {
		schemaVersion: 1,
		kind: "symmio.snapshot",
		inputDigest: bundle.resolved.inputDigest,
		chainId: f.profile.network.chainId,
		blockNumber: 100,
		blockHash: hash(4),
		core: address(1),
		owner: address(2),
		coreCodeHash: hash(5),
		facets: [{ address: address(6), codeHash: hash(3), selectors: ["0x1f931c1c", iface.getFunction("foo").selector] }],
	};
	return { ...f, bundle, snapshot };
}

test("one planner handles distinct deployment profiles with deterministic non-executable selector changes", t => {
	const f = fixture(t);
	const a = buildCorePlan(f.bundle, f.snapshot);
	assert.equal(a.executable, false);
	assert.equal(a.snapshotDigest, operationDigest(f.snapshot));
	assert.deepEqual(a.changes.map(c => c.change).sort(), ["add", "replace"]);
	assert.ok(!a.changes.some(c => c.selector === "0x1f931c1c"));
	assert.deepEqual(buildCorePlan(f.bundle, f.snapshot), a);
	const other = structuredClone(f.bundle),
		snapshot = structuredClone(f.snapshot);
	other.resolved.profile.network.chainId = snapshot.chainId = 42161;
	other.resolved.profile.components.core.address = snapshot.core = address(100);
	other.resolved.profile.components.core.upgradeAuthority = snapshot.owner = address(101);
	other.resolved.profile.components.core.baseline.facetCodeHashes = [hash(20)];
	snapshot.facets[0].codeHash = hash(20);
	assert.equal(buildCorePlan(other, snapshot).target, address(100));
	assert.deepEqual(other.resolved.release, f.bundle.resolved.release);
	other.resolved.profile.components.core.baseline.id = "unsupported-release";
	assert.throws(() => buildCorePlan(other, snapshot), /does not support/);
});

test("planning rejects wrong authority, unsupported baselines, duplicate selectors and unreviewed removals", t => {
	const f = fixture(t);
	for (const mutate of [
		s => (s.owner = address(7)),
		s => s.chainId++,
		s => (s.facets[0].codeHash = hash(8)),
		s => s.facets[0].selectors.push("0x12345678"),
		s => s.facets[0].selectors.push(s.facets[0].selectors[1]),
	]) {
		const snapshot = structuredClone(f.snapshot);
		mutate(snapshot);
		assert.throws(() => buildCorePlan(f.bundle, snapshot));
	}
	f.bundle.artifacts[0].abi.push("function diamondCut((address,uint8,bytes4[])[],address,bytes)");
	assert.throws(() => buildCorePlan(f.bundle, f.snapshot), /reserved/);
});

test("a reviewed removal is explicit and does not become executable calldata", t => {
	const f = fixture(t);
	f.snapshot.facets[0].selectors.push("0x12345678");
	f.bundle.resolved.release.components.core.allowedRemovedSelectors = ["0x12345678"];
	const plan = buildCorePlan(f.bundle, f.snapshot);
	assert.equal(plan.changes.find(c => c.selector === "0x12345678").change, "remove");
	assert.equal(plan.executable, false);
	assert.equal(plan.calldata, undefined);
});

test("malformed ABI entries cannot silently disappear from the release plan", t => {
	const f = fixture(t);
	f.bundle.artifacts[0].abi.push("function malformed(");
	assert.throws(
		() => buildCorePlan(f.bundle, f.snapshot),
		error => error.code === "invalid-artifact",
	);
});

test("snapshot pins every read, uses provider-only calls and refuses a changed block hash", async t => {
	const f = fixture(t);
	const loupe = new Interface([
		"function getOwner() view returns(address)",
		"function facets() view returns ((address facetAddress,bytes4[] functionSelectors)[])",
	]);
	const reads = [];
	let reorg = false,
		blockReads = 0;
	const provider = {
		getNetwork: async () => ({ chainId: BigInt(f.snapshot.chainId) }),
		getBlock: async tag => {
			reads.push(tag);
			return { number: 100, hash: reorg && ++blockReads > 1 ? hash(9) : hash(4) };
		},
		getCode: async (_a, tag) => {
			reads.push(tag);
			return "0x6000";
		},
		call: async tx => {
			reads.push(tx.blockTag);
			const method = loupe.parseTransaction(tx).name;
			return loupe.encodeFunctionResult(method, method === "getOwner" ? [address(2)] : [[[address(6), f.snapshot.facets[0].selectors]]]);
		},
	};
	const captured = await captureCoreSnapshot(provider, f.bundle.resolved);
	assert.equal(captured.facets[0].codeHash, keccak256("0x6000"));
	assert.equal(captured.blockHash, hash(4));
	assert.ok(reads.slice(1).every(tag => tag === 100));
	reorg = true;
	await assert.rejects(captureCoreSnapshot(provider, f.bundle.resolved), /block/);
});
