import { assessDeployment, evidenceDigest } from "../../deployment-tooling/operations/assurance.js";
import { hashSourceTree } from "../../deployment-tooling/operations/source-manifest.js";
import { keccak256 } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const blockHash = `0x${"b".repeat(64)}`;
const hash = `0x${"a".repeat(64)}`;
const address = `0x${"1".repeat(40)}`;
const now = new Date("2026-10-01T00:05:00Z");
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-assurance-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const sourceHash = hashSourceTree(root);
	const report = {
		deploymentId: "fixture",
		chainId: 1,
		lifecycle: "complete",
		deployerAddress: address,
		addresses: { diamond: address, accountLayerDiamond: address, instantLayer: address },
		config: { liquidationInsuranceVault: address, softLiquidationPenaltyCollector: address, maxLiquidationProfitPerPosition: "1" },
		checks: { health: "passed", verificationPolicy: "required", verification: "passed" },
		recipe: { name: "fixture", digest: "fixture" },
		transactions: [{ status: "confirmed", hash }],
		ownershipHandover: { status: "complete" },
		manualActions: [],
	};
	const input = {
		apiVersion: "operations.symm.io/assurance-input-v1",
		chainId: 1,
		reportDigest: evidenceDigest(report),
		sourceHash,
		finalized: { number: 100, hash: blockHash, at: "2026-10-01T00:00:00Z" },
		finalityPolicy: "owner-provided-finalized",
		maxAgeMs: 3600000,
		deadlineMs: 200,
		components: [{ id: "core", address, codeHash: keccak256("0x1234"), requiredChecks: ["Runtime bytecode", "Ownership and roles"] }],
		journal: [{ hash, nonce: 1, confirmations: 1, from: address, to: address, data: "0x1234", value: "0" }],
	};
	const evidence = {
		chainId: 1,
		blockHash,
		sourceHash,
		capturedAt: "2026-10-01T00:00:00Z",
		report,
		doctorCode: 0,
		strictResults: [
			{ check: "Runtime bytecode", status: "pass" },
			{ check: "Ownership and roles", status: "pass" },
		],
		context: { digest: "fixture", recipe: { name: "fixture", network: { mode: "live" } } },
	};
	const component = { chainId: 1, blockHash, address, code: "0x1234", results: evidence.strictResults };
	const reader = {
		report: async () => evidence,
		component: async () => component,
		transaction: async () => ({ chainId: 1, blockHash, status: "confirmed" }),
	};
	return { root, input, reader, evidence, component };
}
test("offline assurance reuses strict checks, binds source/report/finalized block and preserves inputs", async t => {
	const { root, input, reader } = fixture(t);
	const original = structuredClone(input);
	const result = await assessDeployment(input, reader, { root, now });
	assert.equal(result.status, "complete");
	assert.equal(result.finalized.hash, blockHash);
	assert.equal(result.evidenceKind, "owner-provided");
	assert.deepEqual(input, original);
	assert.ok(result.checks.some(item => item.id === "check-13" && item.status === "passed"));
});
test("incorrect identity/authority is failed; missing, stale or partial evidence stays incomplete", async t => {
	const { root, input, reader, component, evidence } = fixture(t);
	component.code = "0xabcd";
	assert.equal((await assessDeployment(input, reader, { root, now })).status, "failed");
	component.code = "0x1234";
	component.results = [
		{ check: "Runtime bytecode", status: "pass" },
		{ check: "Ownership and roles", status: "fail" },
	];
	assert.equal((await assessDeployment(input, reader, { root, now })).status, "failed");
	component.results = [];
	assert.equal((await assessDeployment(input, reader, { root, now })).status, "incomplete");
	component.results = evidence.strictResults;
	evidence.strictResults = undefined;
	assert.equal((await assessDeployment(input, reader, { root, now })).status, "incomplete");
	evidence.strictResults = component.results;
	assert.equal((await assessDeployment(input, reader, { root, now: new Date("2026-10-03T00:00:00Z") })).status, "incomplete");
	evidence.report.chainId = 2;
	assert.equal((await assessDeployment(input, reader, { root, now })).status, "failed");
});
test("a hung evidence read expires within the global budget and later observations stay unknown", async t => {
	const { root, input, reader } = fixture(t);
	reader.component = () => new Promise(() => {});
	const start = Date.now();
	const result = await assessDeployment({ ...input, deadlineMs: 25 }, reader, { root, now });
	assert.ok(Date.now() - start < 1000);
	assert.equal(result.status, "incomplete");
	assert.equal(result.components[0].status, "unknown");
});
test("unsafe live policy, duplicate scope and ambiguous block inputs are refused", async t => {
	const { root, input, reader } = fixture(t);
	for (const override of [
		{ finalityPolicy: "latest" },
		{ finalized: { number: 100 } },
		{ components: [...input.components, ...input.components] },
		{ deadlineMs: 0 },
	]) {
		await assert.rejects(assessDeployment({ ...input, ...override }, reader, { root, now }));
	}
});
