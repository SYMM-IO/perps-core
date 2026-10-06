import { operationDigest } from "../../deployment-tooling/operations/inputs.js";
import { verifyMuonReadiness } from "../../deployment-tooling/operations/muon-readiness.js";
import { captureMuonConfiguration } from "../../deployment-tooling/operations/muon-upgrade.js";
import { muonUpgradeFixture } from "./fixtures/muon-upgrade.js";
import { Interface, toBeHex, keccak256 } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

async function fixture() {
	const f = muonUpgradeFixture(),
		snapshot = await captureMuonConfiguration(f.provider, f.profile, f.checkpoint);
	const bindings = {
		chainId: f.profile.chainId,
		core: f.core,
		upgradeInputDigest: "a".repeat(64),
		cutDigest: "b".repeat(64),
		releaseCommit: "c".repeat(40),
		configurationDigest: operationDigest(snapshot.configuration),
	};
	const document = {
		schemaVersion: 1,
		kind: "symmio.muon-readiness",
		bindings,
		service: {
			chainId: bindings.chainId,
			core: f.core,
			appId: "7",
			releaseCommit: bindings.releaseCommit,
			configurationDigest: "sha256:" + "d".repeat(64),
			methods: ["uPnl_A"],
			observedAt: 1000,
			registered: true,
		},
		canaries: [
			{
				route: "instant",
				function: "Trading",
				method: "uPnl_A",
				signedTimestamp: 1000,
				valid: { from: f.admin, to: f.instant, value: "0x0", data: "0x1234567801" },
				invalid: { from: f.admin, to: f.instant, value: "0x0", data: "0x1234567800" },
				expectedReturnData: "0x",
			},
		],
	};
	const errorABI = new Interface(["error Error(string)", "error OperationFailed(uint256,bytes)"]);
	const rejection = errorABI.encodeErrorResult("OperationFailed", [
		0,
		errorABI.encodeErrorResult("Error", ["MuonSignatureVerifier: TSS not verified"]),
	]);
	const result = [
		{
			timestamp: "0x03e9",
			calls: [
				{ status: "0x1", returnData: "0x" },
				{ status: "0x0", returnData: rejection },
				{ status: "0x1", returnData: "0x" },
			],
		},
	];
	const send = f.provider.send,
		simulations = [];
	f.provider.send = async (method, args) => {
		if (method === "eth_simulateV1") {
			simulations.push(args);
			return result;
		}
		return send(method, args);
	};
	const context = {
		profile: f.profile,
		snapshot,
		checkpoint: f.checkpoint,
		bindings,
		entrypoints: [{ id: "instant", address: f.instant, codeHash: keccak256(f.state.code) }],
		restoreCall: {
			from: f.admin,
			to: f.core,
			value: "0x0",
			data: new Interface(["function unpauseGlobal()"]).encodeFunctionData("unpauseGlobal"),
		},
	};
	return { ...f, snapshot, document, context, result, simulations, errorABI };
}

test("Muon readiness simulates maintenance restore, negative rejection and fresh positive routed call without broadcasting", async () => {
	const f = await fixture(),
		proof = await verifyMuonReadiness(f.provider, f.context, f.document);
	assert.equal(proof.serviceEvidence, "operator-attested");
	assert.equal(proof.executionEvidence, "read-only-simulation");
	assert.equal(f.simulations[0][1], "0x0c");
	assert.deepEqual(f.simulations[0][0].blockStateCalls[0].calls, [
		f.context.restoreCall,
		f.document.canaries[0].invalid,
		f.document.canaries[0].valid,
	]);
	assert.equal(f.simulations[0][0].validation, false);
	assert.equal(Object.hasOwn(f.simulations[0][0].blockStateCalls[0], "stateOverrides"), false);
	assert.ok(f.calls.every(c => !c.method.startsWith("eth_send")));
});

test("Muon restoration rejects missing routes, stale/future signatures, wrong service identity and unregistered releases", async () => {
	for (const [change, message] of [
		[f => (f.document.canaries = []), /every declared route/],
		[f => (f.document.canaries[0].signedTimestamp = 800), /expired/],
		[f => (f.document.canaries[0].signedTimestamp = 1100), /future_dated/],
		[f => (f.document.service.core = toBeHex(99, 20)), /unconfirmed/],
		[f => (f.document.service.registered = false), /unconfirmed/],
		[f => (f.document.service.releaseCommit = "e".repeat(40)), /unconfirmed/],
		[f => (f.document.service.observedAt = 399), /refreshed/],
		[f => (f.document.canaries[0].valid.to = f.verifier), /target/],
		[f => (f.state.gatewayAllowed = false), /configuration changed/],
		[f => (f.document.bindings.cutDigest = "e".repeat(64)), /bind/],
	]) {
		const f = await fixture();
		f.document = structuredClone(f.document);
		change(f);
		await assert.rejects(verifyMuonReadiness(f.provider, f.context, f.document), message);
	}
});

test("unsupported category and empty active signer inventory block readiness without granting any permission", async () => {
	for (const mutate of [f => (f.state.supported = false), f => (f.state.keys = []), f => (f.state.gateways = [])]) {
		const f = await fixture();
		mutate(f);
		f.context.snapshot = await captureMuonConfiguration(f.provider, f.profile, f.checkpoint);
		f.context.bindings.configurationDigest = operationDigest(f.context.snapshot.configuration);
		await assert.rejects(verifyMuonReadiness(f.provider, f.context, f.document), /lacks capability/);
	}
});

test("successful deposit or unrelated authentication failure cannot satisfy the negative Muon probe", async () => {
	for (const change of [
		f => (f.result[0].calls[1].status = "0x1"),
		f => (f.result[0].calls[1].returnData = f.errorABI.encodeErrorResult("Error", ["Invalid user signature"])),
		f => (f.result[0].calls[2].returnData = "0xab"),
		f => (f.result[0].calls[0].status = "0x0"),
	]) {
		const f = await fixture();
		change(f);
		await assert.rejects(verifyMuonReadiness(f.provider, f.context, f.document), /probe|canary|restoration/);
	}
});

test("unsupported or malformed simulation RPC never yields readiness", async () => {
	const f = await fixture(),
		send = f.provider.send;
	f.provider.send = async (method, args) => {
		if (method === "eth_simulateV1") throw new Error("Unsupported RPC");
		return send(method, args);
	};
	await assert.rejects(verifyMuonReadiness(f.provider, f.context, f.document), /provide an eth_simulateV1-capable RPC/);
	f.provider.send = send;
	f.result[0].calls.pop();
	await assert.rejects(verifyMuonReadiness(f.provider, f.context, f.document), /incomplete/);
});
