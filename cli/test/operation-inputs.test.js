import { loadOperation, assertOperationUnchanged, validateDocument, operationDigest } from "../../deployment-tooling/operations/inputs.js";
import { operationFixture } from "./fixtures/operation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("standard request rejects execution, unsupported components, unknown fields and secret-bearing references", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "operation-schema-"));
	try {
		const f = operationFixture(root);
		assert.equal(validateDocument("request", f.request), f.request);
		for (const mutate of [
			x => (x.execution.mode = "execute"),
			x => (x.parameters.components = ["gaslessLayer"]),
			x => (x.privateKey = "sensitive-value"),
			x => (x.deploymentProfile = "https://user:secret@rpc.invalid"),
			x => (x.schemaVersion = 2),
		]) {
			const changed = structuredClone(f.request);
			mutate(changed);
			assert.throws(
				() => validateDocument("request", changed),
				error => error.code === "invalid-document" && !error.message.includes("sensitive-value") && !error.message.includes("user:secret"),
			);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("relative documents resolve from their owning file and freeze every dependency", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "operation-input-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const f = operationFixture(root);
	const loaded = loadOperation(f.file);
	assert.equal(loaded.resolved.profile.id, "fixture");
	assert.equal(loaded.artifacts[0].contractName, "NewFacet");
	assert.equal(loaded.resolved.inputDigest, operationDigest(loaded.resolved.bindings));
	assertOperationUnchanged(f.file, loaded.resolved.inputDigest);
	for (const file of [f.file, f.profileFile, f.releaseFile, f.recipeFile, f.artifactFile]) {
		const saved = fs.readFileSync(file);
		fs.appendFileSync(file, "\n");
		assert.throws(() => assertOperationUnchanged(f.file, loaded.resolved.inputDigest));
		fs.writeFileSync(file, saved);
	}
});

test("rejects wrong chain, zero target and artifact hash mismatch before inspection", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "operation-invalid-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const f = operationFixture(root);
	const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value));
	const original = structuredClone(f.profile);
	f.profile.network.chainId = 999;
	write(f.profileFile, f.profile);
	assert.throws(() => loadOperation(f.file), /network/);
	f.profile = structuredClone(original);
	f.profile.components.core.address = "0x" + "0".repeat(40);
	write(f.profileFile, f.profile);
	assert.throws(() => loadOperation(f.file), /address/);
	write(f.profileFile, original);
	fs.appendFileSync(f.artifactFile, " ");
	assert.throws(() => loadOperation(f.file), /artifact/);
});
