import {
	loadConfigurationRequest,
	prepareConfiguration,
	verifyPreparedConfiguration,
} from "../../deployment-tooling/operations/configuration-request.js";
import { operationDigest, hashBytes } from "../../deployment-tooling/operations/inputs.js";
import { captureMuonConfiguration, verifyMuonConfiguration, muonUpgradePolicy } from "../../deployment-tooling/operations/muon-upgrade.js";
import { muonUpgradeFixture } from "./fixtures/muon-upgrade.js";
import { toBeHex, ZeroHash } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Muon snapshots retain denied categories, override sentinels and separate verifier authorities using pinned views", async () => {
	const f = muonUpgradeFixture(),
		snapshot = await captureMuonConfiguration(f.provider, f.profile, f.checkpoint);
	assert.equal(snapshot.configuration.appId, "7");
	assert.deepEqual(snapshot.configuration.publicKeys[0].permissions, [true, false, false, false, false, false, false, false, false]);
	assert.deepEqual(snapshot.configuration.functions[0].validity, { seconds: "60", overridden: false });
	assert.equal(snapshot.configuration.functions.at(-1).validity, null);
	assert.equal(snapshot.configuration.roles.find(r => r.role === ZeroHash).members[0], f.admin);
	assert.ok(f.calls.filter(c => c.method === "eth_call").every(c => c.args[1] === "0x0c"));
	assert.ok(f.calls.every(c => ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(c.method)));
});

test("Muon preservation rejects permission, app, window and administrative drift", async () => {
	for (const mutate of [
		f => (f.state.keyAllowed = false),
		f => (f.state.gatewayAllowed = false),
		f => f.state.appId++,
		f => (f.state.override = true),
		f => f.roles.get(ZeroHash).push(toBeHex(99, 20)),
	]) {
		const f = muonUpgradeFixture(),
			snapshot = await captureMuonConfiguration(f.provider, f.profile, f.checkpoint);
		mutate(f);
		await assert.rejects(verifyMuonConfiguration(f.provider, f.profile, snapshot, f.checkpoint, operationDigest(snapshot)), /changed/);
	}
});

test("Muon snapshots fail closed on unavailable getters, wrong code, incomplete enumeration and changed blocks", async () => {
	for (const [mutate, message] of [
		[f => (f.state.fail = "isPublicKeyAuthorized"), /unavailable/],
		[f => (f.state.code = "0x6001"), /runtime/],
		[f => f.roles.get(ZeroHash).push(...Array(5).fill(f.admin)), /limit/],
		[f => (f.state.hash = toBeHex(13, 32)), /canonical/],
	]) {
		const f = muonUpgradeFixture();
		mutate(f);
		await assert.rejects(captureMuonConfiguration(f.provider, f.profile, f.checkpoint), message);
	}
});

test("Muon profiles reject unknown categories, duplicate standard roles and user-state inputs", () => {
	assert.throws(() => muonUpgradePolicy({ requiredFunctions: ["Unknown"] }), /Invalid/);
	assert.throws(() => muonUpgradePolicy({ additionalVerifierRoles: [ZeroHash] }), /Invalid/);
	assert.throws(() => muonUpgradePolicy({ nonces: [] }), /Invalid/);
});

test("configuration requests bind a Muon profile and verify its preserved dependencies", async t => {
	const f = muonUpgradeFixture(),
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "muon-bundle-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const write = (name, value) => {
		const bytes = JSON.stringify(value);
		fs.writeFileSync(path.join(directory, name), bytes);
		return { file: name, sha256: hashBytes(bytes) };
	};
	const profile = { schemaVersion: 1, kind: "symmio.configuration-profile", chainId: f.profile.chainId, source: f.profile.core, fields: [] };
	const request = {
		schemaVersion: 1,
		kind: "symmio.configuration-request",
		sourceCommit: "a".repeat(40),
		credentialRecipe: "recipe.json",
		profile: write("configuration.json", profile),
		muon: write("muon.json", f.profile),
		sourceCheckpoint: f.checkpoint,
	};
	const file = path.join(directory, "request.json");
	write("request.json", request);
	const inspected = await prepareConfiguration(f.provider, loadConfigurationRequest(file));
	assert.equal(inspected.muon.configuration.appId, "7");
	request.target = { contract: f.profile.core, checkpoint: f.checkpoint };
	write("request.json", request);
	const bundle = loadConfigurationRequest(file),
		prepared = await prepareConfiguration(f.provider, bundle);
	await verifyPreparedConfiguration(f.provider, bundle, prepared, f.checkpoint, operationDigest(prepared));
	f.state.gatewayAllowed = false;
	await assert.rejects(verifyPreparedConfiguration(f.provider, bundle, prepared, f.checkpoint, operationDigest(prepared)), /changed/);
	write("muon.json", { ...f.profile, chainId: 1 });
	assert.throws(() => loadConfigurationRequest(file), /profile changed/);
});
