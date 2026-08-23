import {
	MUON_FUNCTION_NAMES,
	checkMuonFunctionMirrorDrift,
	inspectMuonFunctionAuthorizations,
	muonAuthorizationVerdict,
	parseMuonFunctionPermissions,
} from "../lib/muon-permissions.js";
import assert from "node:assert/strict";
import test from "node:test";

const completeProfile = MUON_FUNCTION_NAMES.join(",");

test("Muon permission names and indices mirror the Solidity enum", () => {
	assert.deepEqual(checkMuonFunctionMirrorDrift().problems, []);
});

test("Muon permission parser requires the exact complete nine-category profile", () => {
	assert.deepEqual(
		parseMuonFunctionPermissions(completeProfile).map(({ name, index }) => [name, index]),
		MUON_FUNCTION_NAMES.map((name, index) => [name, index]),
	);
	assert.throws(() => parseMuonFunctionPermissions(""), /must contain all MuonFunction names/);
	assert.throws(() => parseMuonFunctionPermissions(`${completeProfile},Trading`), /duplicate MuonFunction Trading/);
	assert.throws(() => parseMuonFunctionPermissions(completeProfile.replace("RemoveMargin", "Unknown")), /unknown MuonFunction "Unknown"/);
	assert.throws(() => parseMuonFunctionPermissions(completeProfile.replace(",RemoveMargin", "")), /missing: RemoveMargin/);
	assert.throws(() => parseMuonFunctionPermissions(completeProfile.replace("Settlement", "")), /empty entry/);
});

test("Muon authorization inspection probes every configured key and gateway category", async () => {
	const calls = [];
	const reader = {
		async isPublicKeyAuthorized(key, index) {
			calls.push(["key", String(key.x), index]);
			return index !== 7;
		},
		async isGatewaySignerAuthorized(signer, index) {
			calls.push(["gateway", signer, index]);
			return index !== 3;
		},
	};
	const missing = await inspectMuonFunctionAuthorizations(reader, {
		publicKeys: [{ x: "123", parity: 1 }],
		gatewaySigners: ["0x0000000000000000000000000000000000000001"],
	});

	assert.equal(calls.length, 18);
	assert.deepEqual(missing, ["public key x=123, parity=1: RemoveMargin", "gateway signer 0x0000000000000000000000000000000000000001: ForceClose"]);
	assert.equal(muonAuthorizationVerdict(missing, false), "blocked");
	assert.equal(muonAuthorizationVerdict(missing, true), "repairable");
	assert.equal(muonAuthorizationVerdict([], false), "ok");
});

test("Muon authorization inspection fails closed when a verifier probe reverts", async () => {
	const reader = {
		async isPublicKeyAuthorized() {
			throw new Error("read reverted");
		},
		async isGatewaySignerAuthorized() {
			return true;
		},
	};
	await assert.rejects(
		inspectMuonFunctionAuthorizations(reader, {
			publicKeys: [{ x: "123", parity: 1 }],
			gatewaySigners: ["0x0000000000000000000000000000000000000001"],
		}),
		/read reverted/,
	);
});
