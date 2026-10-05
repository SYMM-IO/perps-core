import { operationDigest } from "../../deployment-tooling/operations/inputs.js";
import { buildWiringMigration, captureWiringSnapshot, verifyWiringMigration } from "../../deployment-tooling/operations/wiring-migration.js";
import { Interface, id, keccak256, toBeHex } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const address = n => toBeHex(n, 20),
	old = address(1),
	replacement = address(2),
	owner = address(3),
	consumer = address(4);
const code = "0x6000",
	checkpoint = { blockNumber: 9, blockHash: toBeHex(9, 32) };
const authority = { address: owner, read: { signature: "function owner() view returns(address)", args: [] } };
const member = (name, role) => ({
	id: name,
	dependency: "instant",
	source: old,
	consumer: { address: consumer, codeHash: keccak256(code) },
	authority,
	kind: "membership",
	read: { signature: "function hasRole(bytes32 role,address account) view returns(bool)", args: [role, { ref: "source" }] },
	set: { signature: "function grantRole(bytes32 role,address account)", args: [role, { ref: "replacement" }] },
	clear: { signature: "function revokeRole(bytes32 role,address account)", args: [role, { ref: "source" }] },
});
const pointer = {
	id: "gateway",
	dependency: "instant",
	source: old,
	consumer: { address: consumer, codeHash: keccak256(code) },
	authority,
	kind: "address",
	read: { signature: "function instantLayer() view returns(address)", args: [] },
	set: { signature: "function setInstantLayer(address layer)", args: [{ ref: "replacement" }] },
};
const profile = { schemaVersion: 1, chainId: 31337, bindings: [member("active", id("ACTIVE_ROLE")), member("unused", id("UNUSED_ROLE")), pointer] };
function rpc(after = false) {
	const calls = [],
		readers = new Interface([profile.bindings[0].read.signature, pointer.read.signature, authority.read.signature]);
	return {
		calls,
		send: async (method, args) => {
			calls.push([method, args]);
			if (method === "eth_chainId") return toBeHex(profile.chainId);
			if (method === "eth_getBlockByNumber") return { hash: checkpoint.blockHash };
			if (method === "eth_getCode") return code;
			const parsed = readers.parseTransaction(args[0]);
			const result =
				parsed.name === "owner"
					? owner
					: parsed.name === "instantLayer"
						? after
							? replacement
							: old
						: parsed.args[0] === id("ACTIVE_ROLE") && parsed.args[1].toLowerCase() === (after ? replacement : old);
			return readers.encodeFunctionResult(parsed.fragment, [result]);
		},
	};
}

test("wiring migrates observed pointers and active roles while preserving unused roles", async () => {
	const provider = rpc(),
		snapshot = await captureWiringSnapshot(provider, profile, checkpoint),
		plan = buildWiringMigration(profile, snapshot, { instant: replacement });
	assert.equal(plan.activate.length, 2);
	assert.equal(plan.retire.length, 1);
	assert.ok(plan.activate.every(action => action.authority === owner));
	assert.ok(!plan.activate.some(action => action.id.startsWith("unused")));
	assert.equal((await verifyWiringMigration(rpc(true), plan, checkpoint)).checks, 5);
	assert.ok(provider.calls.filter(([method]) => method === "eth_call").every(([, args]) => args[1] === "0x09"));
});

test("wiring rejects incomplete snapshots, changed intents and failed post-state", async () => {
	const snapshot = await captureWiringSnapshot(rpc(), profile, checkpoint);
	assert.throws(
		() => buildWiringMigration(profile, { ...snapshot, observations: snapshot.observations.slice(1) }, { instant: replacement }),
		/incomplete/,
	);
	assert.throws(() => buildWiringMigration(profile, { ...snapshot, profileDigest: "changed" }, { instant: replacement }), /binding/);
	const plan = buildWiringMigration(profile, snapshot, { instant: replacement });
	await assert.rejects(verifyWiringMigration(rpc(), plan, checkpoint), /post-state/);
	await assert.rejects(verifyWiringMigration(rpc(true), { ...plan, activate: [] }, checkpoint), /changed/);
	const untrusted = structuredClone(profile);
	untrusted.bindings[0].set.args[1] = { ref: "shellCommand" };
	assert.throws(
		() => buildWiringMigration(untrusted, { ...snapshot, profileDigest: operationDigest(untrusted) }, { instant: replacement }),
		/reference/,
	);
});

test("wiring requires replacement/retirement references and rechecks runtime and authority", async () => {
	const snapshot = await captureWiringSnapshot(rpc(), profile, checkpoint);
	for (const field of ["read", "set", "clear"]) {
		const changed = structuredClone(profile);
		changed.bindings[0][field].args[1] = old;
		await assert.rejects(captureWiringSnapshot(rpc(), changed, checkpoint), /reference/);
	}
	const plan = buildWiringMigration(profile, snapshot, { instant: replacement });
	const after = rpc(true);
	await assert.rejects(
		verifyWiringMigration(
			{ send: (method, args) => (method === "eth_getCode" ? Promise.resolve("0x6001") : after.send(method, args)) },
			plan,
			checkpoint,
		),
		/runtime/,
	);
	const ownerAbi = new Interface([authority.read.signature]);
	await assert.rejects(
		verifyWiringMigration(
			{
				send: (method, args) =>
					method === "eth_call" && args[0].data === ownerAbi.encodeFunctionData("owner")
						? Promise.resolve(ownerAbi.encodeFunctionResult("owner", [replacement]))
						: after.send(method, args),
			},
			plan,
			checkpoint,
		),
		/authority/,
	);
});
