import {
	loadConfigurationRequest,
	prepareConfiguration,
	verifyPreparedConfiguration,
} from "../../deployment-tooling/operations/configuration-request.js";
import { hashBytes, operationDigest } from "../../deployment-tooling/operations/inputs.js";
import { readRoleInventory } from "../../deployment-tooling/operations/role-migration.js";
import { Interface, id, keccak256, toBeHex, ZeroHash } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "symmio-preservation-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const address = n => toBeHex(n, 20),
		source = address(1),
		target = address(2),
		admin = address(3),
		consumer = address(4),
		member = address(5),
		code = "0x6000";
	const contract = address => ({ address, codeHash: keccak256(code) }),
		block = { blockNumber: 12, blockHash: toBeHex(12, 32) };
	const field = {
		id: "cooldown",
		mode: "copy",
		read: { signature: "function revocationCooldown() view returns(uint256)", args: [] },
		write: { signature: "function setRevocationCooldown(uint256)", args: [{ ref: "observed" }] },
		authority: { address: admin, read: { signature: "function owner() view returns(address)", args: [] } },
	};
	const profile = { schemaVersion: 1, kind: "symmio.configuration-profile", chainId: 31337, source: contract(source), fields: [field] };
	const sourceRole = id("SOURCE_ROLE"),
		targetRole = id("TARGET_ROLE");
	const roles = {
		schemaVersion: 1,
		chainId: profile.chainId,
		source: contract(source),
		target: contract(target),
		transitions: [{ id: "template-manager", sourceRole, targetRole, adminRole: ZeroHash, authority: admin, policy: "exact-source-members" }],
	};
	const authority = field.authority;
	const membership = (name, role) => ({
		id: name,
		dependency: "instant",
		source,
		consumer: contract(consumer),
		authority,
		kind: "membership",
		read: { signature: "function hasRole(bytes32,address) view returns(bool)", args: [role, { ref: "source" }] },
		set: { signature: "function grantRole(bytes32,address)", args: [role, { ref: "replacement" }] },
		clear: { signature: "function revokeRole(bytes32,address)", args: [role, { ref: "source" }] },
	});
	const wiring = {
		schemaVersion: 1,
		chainId: profile.chainId,
		bindings: [
			membership("active", id("ACTIVE_ROLE")),
			membership("inactive", id("INACTIVE_ROLE")),
			{
				id: "gateway",
				dependency: "instant",
				source,
				consumer: contract(consumer),
				authority,
				kind: "address",
				read: { signature: "function instantLayer() view returns(address)", args: [] },
				set: { signature: "function setInstantLayer(address)", args: [{ ref: "replacement" }] },
			},
		],
	};
	const write = (name, value) => {
		const file = path.join(directory, name);
		fs.writeFileSync(file, JSON.stringify(value));
		return { file: name, sha256: hashBytes(fs.readFileSync(file)) };
	};
	const request = {
		schemaVersion: 1,
		kind: "symmio.configuration-request",
		sourceCommit: "a".repeat(40),
		credentialRecipe: "./recipe.json",
		profile: write("profile.json", profile),
		sourceCheckpoint: block,
		target: { contract: contract(target), checkpoint: block },
		roles: { ...write("roles.json", roles), maxMembersPerRole: 10 },
		wiring: { ...write("wiring.json", wiring), dependency: "instant" },
	};
	write("request.json", request);
	const iface = new Interface([
		field.read.signature,
		field.authority.read.signature,
		"function getRoleMemberCount(bytes32) view returns(uint256)",
		"function getRoleMember(bytes32,uint256) view returns(address)",
		"function getRoleAdmin(bytes32) view returns(bytes32)",
		wiring.bindings[0].read.signature,
		wiring.bindings[2].read.signature,
	]);
	const calls = [];
	const provider = (after = false, extra = {}) => ({
		send: async (method, args) => {
			calls.push([method, args]);
			if (method === "eth_chainId") return toBeHex(profile.chainId);
			if (method === "eth_getBlockByNumber") return { hash: toBeHex(BigInt(args[0]), 32) };
			if (method === "eth_getCode") return code;
			if (method !== "eth_call") throw new Error("Unexpected discovery method");
			const fn = iface.parseTransaction(args[0]),
				to = args[0].to,
				sourceCall = to === source;
			let value;
			if (fn.name === "owner") value = admin;
			else if (fn.name === "revocationCooldown") value = sourceCall || after ? 900 : 600;
			else if (fn.name === "getRoleMemberCount") value = sourceCall ? (extra.count ?? 1) : after ? 1 : 0;
			else if (fn.name === "getRoleMember") value = member;
			else if (fn.name === "getRoleAdmin") value = sourceCall && extra.sourceAdmin ? extra.sourceAdmin : ZeroHash;
			else if (fn.name === "instantLayer") value = after ? target : source;
			else if (to === consumer)
				value =
					fn.args[0] === id("ACTIVE_ROLE") &&
					fn.args[1].toLowerCase() === (after ? target : source) &&
					!(extra.drift && args[1] === "0x0d");
			else value = fn.args[0] === ZeroHash ? fn.args[1].toLowerCase() === admin : fn.args[1].toLowerCase() === member && (sourceCall || after);
			return iface.encodeFunctionResult(fn.fragment, [value]);
		},
	});
	return { profile, roles, request, write, requestFile: path.join(directory, "request.json"), provider, calls, block, member, directory };
}

test("one configuration request enumerates role views and plans active consumer wiring with separate retirement", async t => {
	const f = fixture(t),
		bundle = loadConfigurationRequest(f.requestFile),
		result = await prepareConfiguration(f.provider(), bundle);
	assert.equal(result.plan.actions.length, 1);
	assert.deepEqual(result.roles.inventory, [{ role: f.roles.transitions[0].sourceRole, members: [f.member] }]);
	assert.equal(result.roles.plan.actions.length, 1);
	assert.equal(result.wiring.plan.activate.length, 2);
	assert.equal(result.wiring.plan.retire.length, 1);
	assert.ok(!result.wiring.plan.activate.some(a => a.id.startsWith("inactive")));
	const verified = await verifyPreparedConfiguration(f.provider(true), bundle, result, f.block, operationDigest(result));
	assert.equal(verified.configuration.fields, 1);
	assert.equal(verified.roles.transitions, 1);
	assert.equal(verified.wiring.checks, 5);
	assert.ok(f.calls.every(([method]) => ["eth_chainId", "eth_getCode", "eth_getBlockByNumber", "eth_call"].includes(method)));
	const forged = structuredClone(result);
	forged.wiring.plan.checks = [];
	await assert.rejects(verifyPreparedConfiguration(f.provider(true), bundle, forged, f.block, operationDigest(result)), /evidence changed/);
});

test("role enumeration and administrator checks reject partial preservation and consumer drift", async t => {
	const f = fixture(t),
		bundle = loadConfigurationRequest(f.requestFile);
	await assert.rejects(readRoleInventory(f.provider(false, { count: 11 }), f.roles, f.block, 10), /limit exceeded/);
	assert.ok(!f.calls.some(([method, args]) => method === "eth_call" && args[0].data.startsWith(id("getRoleMember(bytes32,uint256)").slice(0, 10))));
	await assert.rejects(prepareConfiguration(f.provider(false, { sourceAdmin: id("UNREVIEWED_ADMIN") }), bundle), /Source role administrator/);
	const changed = structuredClone(f.request);
	changed.target.checkpoint = { blockNumber: 13, blockHash: toBeHex(13, 32) };
	f.write("request.json", changed);
	await assert.rejects(prepareConfiguration(f.provider(false, { drift: true }), loadConfigurationRequest(f.requestFile)), /wiring changed/);
	const provider = f.provider(),
		getter = new Interface([f.profile.fields[0].read.signature]);
	await assert.rejects(
		prepareConfiguration(
			{
				send: (method, args) =>
					method === "eth_call" &&
					args[0].to === f.profile.source.address &&
					args[1] === "0x0d" &&
					args[0].data === getter.encodeFunctionData("revocationCooldown")
						? Promise.resolve(getter.encodeFunctionResult("revocationCooldown", [901]))
						: provider.send(method, args),
			},
			loadConfigurationRequest(f.requestFile),
		),
		/source changed/,
	);
});

test("request binds role and consumer profiles to the exact replacement, chain and file bytes", async t => {
	const f = fixture(t);
	const changed = structuredClone(f.roles);
	changed.target.address = toBeHex(9, 20);
	f.request.roles = { ...f.write("roles.json", changed), maxMembersPerRole: 10 };
	f.write("request.json", f.request);
	assert.throws(() => loadConfigurationRequest(f.requestFile), /source, target/);
	f.request.roles = { ...f.write("roles.json", f.roles), maxMembersPerRole: 10 };
	f.write("request.json", f.request);
	fs.appendFileSync(path.join(f.directory, "wiring.json"), " ");
	assert.throws(() => loadConfigurationRequest(f.requestFile), /wiring profile changed/);
	const withoutTarget = structuredClone(f.request);
	delete withoutTarget.target;
	f.write("request.json", withoutTarget);
	assert.throws(() => loadConfigurationRequest(f.requestFile), /deployed target/);
});
