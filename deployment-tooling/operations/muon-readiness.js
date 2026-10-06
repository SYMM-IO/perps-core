import { assertMuonSignatureFresh } from "../muon-signature.js";
import { operationDigest } from "./inputs.js";
import { captureMuonConfiguration, muonUpgradePolicy } from "./muon-upgrade.js";
import { Interface, getAddress, keccak256, toBeHex } from "ethers";

const errors = new Interface([
	"error Error(string)",
	"error OperationFailed(uint256,bytes)",
	"error HookActionFailed(bytes)",
	"error HookFailed(bytes)",
]);
// Release-specific verifier errors, not deployment addresses or service settings.
const muonErrors = new Set([
	"MuonSignatureVerifier: TSS not verified",
	"MuonSignatureVerifier: Gateway is not valid",
	"MuonSignatureVerifier: Key not authorized for function",
	"MuonSignatureVerifier: Gateway not authorized for function",
]);
function muonRevert(data, depth = 0) {
	if (depth > 8) return false;
	try {
		const parsed = errors.parseError(data);
		if (!parsed) return false;
		if (parsed.name === "Error") return muonErrors.has(parsed.args[0]);
		return muonRevert(parsed.args[parsed.name === "OperationFailed" ? 1 : 0], depth + 1);
	} catch {
		return false;
	}
}
function exact(value, keys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
		throw new Error(`Invalid Muon ${label}`);
}
function transaction(call, target) {
	exact(call, ["from", "to", "data", "value"], "canary call");
	if (
		getAddress(call.to) !== getAddress(target) ||
		!/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(call.data) ||
		!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(call.value)
	)
		throw new Error("Muon canary target, calldata or value differs");
	getAddress(call.from);
	return { ...call };
}
function validateDocument(document, bindings, entrypoints, snapshot) {
	exact(document, ["schemaVersion", "kind", "bindings", "service", "canaries"], "readiness document");
	if (document.schemaVersion !== 1 || document.kind !== "symmio.muon-readiness" || operationDigest(document.bindings) !== operationDigest(bindings))
		throw new Error("Muon readiness does not bind this upgrade, release and cut");
	exact(
		document.service,
		["chainId", "core", "appId", "releaseCommit", "configurationDigest", "methods", "observedAt", "registered"],
		"service evidence",
	);
	const service = document.service;
	if (
		service.chainId !== bindings.chainId ||
		getAddress(service.core) !== getAddress(bindings.core) ||
		service.appId !== snapshot.configuration.appId ||
		service.releaseCommit !== bindings.releaseCommit ||
		!/^sha256:[0-9a-f]{64}$/.test(service.configurationDigest) ||
		service.registered !== true ||
		!Array.isArray(service.methods) ||
		!service.methods.length ||
		new Set(service.methods).size !== service.methods.length ||
		service.methods.some(method => typeof method !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(method)) ||
		!Number.isSafeInteger(service.observedAt)
	)
		throw new Error("Muon service registration, methods or payload release is unconfirmed");
	if (
		!Array.isArray(entrypoints) ||
		!entrypoints.length ||
		new Set(entrypoints.map(e => e.id)).size !== entrypoints.length ||
		!Array.isArray(document.canaries) ||
		document.canaries.length !== entrypoints.length
	)
		throw new Error("Muon readiness needs every declared route");
	const seen = new Set();
	for (const canary of document.canaries) {
		exact(canary, ["route", "function", "method", "signedTimestamp", "valid", "invalid", "expectedReturnData"], "canary");
		const entrypoint = entrypoints.find(e => e.id === canary.route),
			func = snapshot.configuration.functions.find(f => f.name === canary.function);
		if (
			!entrypoint ||
			seen.has(canary.route) ||
			!func?.validity ||
			!service.methods.includes(canary.method) ||
			!/^0x(?:[0-9a-fA-F]{2})*$/.test(canary.expectedReturnData)
		)
			throw new Error("Muon canary route, method, function or expected output differs");
		seen.add(canary.route);
		transaction(canary.valid, entrypoint.address);
		transaction(canary.invalid, entrypoint.address);
		if (
			canary.valid.from.toLowerCase() !== canary.invalid.from.toLowerCase() ||
			canary.valid.value !== canary.invalid.value ||
			canary.valid.data.slice(0, 10).toLowerCase() !== canary.invalid.data.slice(0, 10).toLowerCase() ||
			canary.valid.data === canary.invalid.data
		)
			throw new Error("Muon positive and negative probes must exercise the same caller and entry selector");
	}
}

/** Read-only readiness evidence. Service facts are operator attestations; routed probes are independently simulated. */
export async function verifyMuonReadiness(provider, { profile, snapshot, checkpoint, bindings, entrypoints, restoreCall }, document) {
	if (restoreCall) {
		transaction(restoreCall, profile.core.address);
		if (restoreCall.value !== "0x0" || restoreCall.data !== new Interface(["function unpauseGlobal()"]).encodeFunctionData("unpauseGlobal"))
			throw new Error("Muon simulation restoration must only unpause the preserved Core");
	}
	const current = await captureMuonConfiguration(provider, profile, checkpoint),
		config = current.configuration;
	if (operationDigest(config) !== operationDigest(snapshot.configuration)) throw new Error("Muon configuration changed before restoration");
	if (
		bindings.chainId !== profile.chainId ||
		getAddress(bindings.core) !== getAddress(profile.core.address) ||
		bindings.configurationDigest !== operationDigest(config)
	)
		throw new Error("Muon readiness configuration binding differs");
	validateDocument(document, bindings, entrypoints, current);
	const policy = muonUpgradePolicy(profile.policy);
	for (const name of policy.requiredFunctions) {
		const func = config.functions.find(f => f.name === name);
		if (
			!func?.supported ||
			!config.publicKeys.some(k => k.permissions[func.index]) ||
			!config.gatewaySigners.some(g => g.permissions[func.index])
		)
			throw new Error(`MuonFunction.${name} lacks capability or an authorized TSS key/gateway`);
	}
	const block = await provider.send("eth_getBlockByNumber", [toBeHex(checkpoint.blockNumber), false]),
		chainTime = Number(BigInt(block.timestamp));
	if (document.service.observedAt > chainTime || chainTime - document.service.observedAt > 600)
		throw new Error("Muon service evidence must be refreshed within ten minutes of chain time");
	const simulations = [];
	for (const canary of document.canaries) {
		const entrypoint = entrypoints.find(e => e.id === canary.route);
		const code = await provider.send("eth_getCode", [entrypoint.address, toBeHex(checkpoint.blockNumber)]);
		if (code === "0x" || keccak256(code) !== entrypoint.codeHash) throw new Error("Muon canary route runtime changed");
		const func = config.functions.find(f => f.name === canary.function);
		assertMuonSignatureFresh(canary.signedTimestamp, { timestamp: chainTime, upnlValidTime: Number(func.validity.seconds) });
		// A negative probe runs first; its revert leaves the positive probe's starting state intact.
		// Governance is impersonated only inside this simulation; no production unpause or signature is sent.
		const calls = [
			...(restoreCall ? [restoreCall] : []),
			transaction(canary.invalid, entrypoint.address),
			transaction(canary.valid, entrypoint.address),
		];
		let blocks;
		try {
			blocks = await provider.send("eth_simulateV1", [
				{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false, returnFullTransactions: false },
				toBeHex(checkpoint.blockNumber),
			]);
		} catch {
			throw new Error(
				"Muon routed simulation unavailable: provide an eth_simulateV1-capable RPC through the credential recipe; restoration remains blocked",
			);
		}
		const result = blocks?.[0],
			simulatedTime = result?.timestamp === undefined ? NaN : Number(BigInt(result.timestamp));
		if (
			!Array.isArray(blocks) ||
			blocks.length !== 1 ||
			result.calls?.length !== calls.length ||
			!Number.isSafeInteger(simulatedTime) ||
			simulatedTime <= chainTime
		)
			throw new Error("Muon routed simulation returned incomplete evidence");
		assertMuonSignatureFresh(canary.signedTimestamp, { timestamp: simulatedTime, upnlValidTime: Number(func.validity.seconds) });
		if (restoreCall && result.calls[0].status !== "0x1") throw new Error("Simulated maintenance restoration failed");
		const invalid = result.calls.at(-2),
			valid = result.calls.at(-1);
		if (invalid.status !== "0x0" || !muonRevert(invalid.returnData && invalid.returnData !== "0x" ? invalid.returnData : invalid.error?.data))
			throw new Error("Negative routed probe did not prove Muon rejection");
		if (valid.status !== "0x1" || valid.returnData?.toLowerCase() !== canary.expectedReturnData.toLowerCase())
			throw new Error("Fresh Muon routed canary failed or returned unexpected data");
		simulations.push({ route: canary.route, function: canary.function, method: canary.method, calls, result });
	}
	const finalBlock = await provider.send("eth_getBlockByNumber", [toBeHex(checkpoint.blockNumber), false]);
	if (finalBlock?.hash?.toLowerCase() !== checkpoint.blockHash.toLowerCase()) throw new Error("Muon readiness block is no longer canonical");
	const latest = await provider.send("eth_getBlockByNumber", ["latest", false]);
	const latestTime = latest?.timestamp === undefined ? NaN : Number(BigInt(latest.timestamp));
	if (!Number.isSafeInteger(latestTime) || latestTime < chainTime || latestTime - document.service.observedAt > 600)
		throw new Error("Muon evidence became stale while checking readiness");
	for (const canary of document.canaries) {
		const func = config.functions.find(f => f.name === canary.function);
		assertMuonSignatureFresh(canary.signedTimestamp, { timestamp: latestTime, upnlValidTime: Number(func.validity.seconds) });
	}
	return {
		schemaVersion: 1,
		kind: "symmio.verified-muon-readiness",
		bindings,
		checkpoint,
		documentDigest: operationDigest(document),
		serviceEvidence: "operator-attested",
		executionEvidence: "read-only-simulation",
		freshnessCheckpoint: { blockNumber: Number(BigInt(latest.number)), blockHash: latest.hash },
		simulations,
	};
}
