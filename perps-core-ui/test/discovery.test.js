import { ADDRESSES_FILE } from "../server/addresses.js";
import { ROOT } from "../server/build.js";
import { parseRoleLog, discoverRoleHistory, addressesIn, inspectDependencies } from "../server/discovery.js";
import { inspectRoleConnections, roleHash, roleNames } from "../server/roles.js";
import { defaultProfiles, validateProfile, pointerConnections } from "../server/system.js";
import { createWorkspace } from "../server/workspace.js";
import { graphModel } from "../shared/graph-model.js";
import { Interface, id, ZeroAddress } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const address = i => `0x${i.toString(16).padStart(40, "0")}`;
const node = (key, kind, i) => ({ id: key, kind, name: key, address: address(i), status: "observed", state: {}, errors: [] });

test("all 27 deployments load with a distinct id and their chain", () => {
	assert.equal(defaultProfiles.length, 27);
	assert.equal(new Set(defaultProfiles.map(p => p.id)).size, 27);
	for (const p of defaultProfiles) {
		// A deployment from the address book says which entry it is and when the file was last checked, with no link.
		assert.deepEqual(Object.keys(p.source).sort(), ["checked", "entry"]);
		validateProfile(p);
	}
	// The file stands on its own: it never says where an address was copied from, and links to no internal document.
	assert.doesNotMatch(fs.readFileSync(path.join(ROOT, ADDRESSES_FILE), "utf8"), /sheet|workbook|docs\.google|"gid"/i);
	assert.equal(defaultProfiles.find(p => p.name === "Monad").chainId, 143);
	assert.equal(
		defaultProfiles.find(p => p.id === "vibe-arbitrum-stage").nodes.find(n => n.id === "core").address,
		"0x573310dB6d160B26026B8706EBe9831c7dEF1D09",
	);
});

test("permission event decoding handles Diamond and OZ indexing; incomplete RPC history is explicit", async () => {
	for (const declaration of [
		"event RoleGranted(bytes32 role,address user)",
		"event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
	]) {
		const iface = new Interface([declaration]),
			f = iface.fragments[0],
			args = f.inputs.length === 2 ? [id("NEW_ROLE"), address(2)] : [id("NEW_ROLE"), address(2), address(3)];
		const log = iface.encodeEventLog(f, args);
		assert.equal(parseRoleLog(log).holder, address(2));
		assert.equal(parseRoleLog(log).hash, id("NEW_ROLE"));
	}
	const nodes = [node("core", "core", 1)];
	const incomplete = await discoverRoleHistory(
		{
			getLogs: async () => {
				throw Error("range limit");
			},
		},
		nodes,
		100,
		() => {},
		3,
	);
	assert.equal(incomplete.complete, false);
	assert.equal(incomplete.requests, 3);
	assert.ok(incomplete.unreadRanges > 0);
	const iface = new Interface(["event RoleGranted(bytes32 role,address user)"]);
	const result = await discoverRoleHistory(
		{ getLogs: async () => [{ address: address(1), ...iface.encodeEventLog(iface.fragments[0], [id("NEW_ROLE"), address(2)]) }] },
		nodes,
		100,
	);
	assert.equal(result.complete, true);
	assert.equal(nodes[0].roleHistory[0].hash, id("NEW_ROLE"));
	assert.ok(nodes.some(n => n.address === address(2)));
});

test("roles cover helper contracts, unknown event hashes, effective admins and correct Express role convention", async () => {
	for (const kind of ["gasless", "liquidator", "symbolManager", "multiAccount", "feeDistributor", "express", "timelock"])
		assert.ok(roleNames(kind).length > 1, kind);
	assert.equal(roleHash("express", "DEFAULT_ADMIN_ROLE"), id("DEFAULT_ADMIN_ROLE"));
	const core = node("core", "core", 1),
		holder = node("operator", "authority", 2),
		gasless = node("gasless", "gasless", 3);
	core.roleHistory = [{ hash: id("UNKNOWN_PERMISSION"), holder: holder.address, admin: false }];
	const edges = await inspectRoleConnections({
		nodes: [core, holder, gasless],
		profile: {},
		read: async (target, signature, args) => {
			if (signature.includes("hasRole(address"))
				return target === core.address && args[0] === holder.address && args[1] === id("UNKNOWN_PERMISSION");
			if (signature.includes("isRoleAdmin")) return target === core.address && args[0] === holder.address && args[1] === id("LIQUIDATOR_ROLE");
			if (signature.includes("hasRole(bytes32"))
				return target === gasless.address && args[0] === id("RELAYER_ROLE") && args[1] === holder.address;
			throw Error("unsupported");
		},
	});
	assert.ok(edges.some(e => e.roleHash === id("UNKNOWN_PERMISSION") && e.kind === "role" && e.status === "verified"));
	assert.ok(edges.some(e => e.roleHash === id("LIQUIDATOR_ROLE") && e.kind === "roleAdmin" && e.from === holder.id));
	assert.ok(edges.some(e => e.label === "RELAYER_ROLE" && e.to === "gasless"));
	assert.ok(!edges.some(e => e.status === "missing"), "observed absence does not invent an expected grant");
});

test("facets and implementations remain discoverable without crowding the default system graph", async () => {
	const iface = new Interface(["function config() view returns((address owner,address[] targets) settings)"]);
	const values = addressesIn(iface.fragments[0].outputs[0], [address(1), [address(2), ZeroAddress]], "config");
	assert.equal(values.length, 2);
	const core = node("core", "core", 1);
	core.implementation = address(4);
	core.diamond = {
		facets: [
			{ address: address(5), selectors: ["0x12345678"], code: "0x1234", codeHash: "test" },
			{ address: address(6), selectors: ["0xabcdef01"], code: "0x5678", codeHash: "test2" },
		],
	};
	const nodes = [core, node("unwired", "external", 9)],
		edges = [];
	await inspectDependencies({
		nodes,
		edges,
		read: async () => {
			throw Error("unsupported");
		},
	});
	const graph = graphModel({ nodes, edges });
	assert.equal(graph.nodes.length, 2);
	assert.equal(graph.edges.length, 0);
	assert.equal(graph.unconnected.length, 0);
	const details = graphModel({ nodes, edges }, { mode: "implementation" });
	assert.equal(details.edges.filter(e => e.kind === "facet").length, 2);
	assert.equal(details.edges.filter(e => e.kind === "implementation").length, 1);
	assert.ok(graph.nodes.some(n => n.id === "unwired"));
});

test("workspace selection validates first and clears prepared state without retaining a provider", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-workspaces-"));
	const w = createWorkspace({ stateRoot: dir });
	try {
		assert.equal(w.status().profile.id, "arbitrum-vibe");
		w.select("base");
		assert.equal(w.status().profile.chainId, 8453);
		assert.equal(w.status().snapshot, null);
		assert.equal(w.status().plan, undefined);
		assert.throws(() => w.select("not-a-workspace"), /Unknown/);
		assert.equal(w.status().profile.id, "base");
	} finally {
		w.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("checkout-only integration roles do not mark older deployed Diamonds as missing", async () => {
	const core = node("core", "core", 1),
		al = node("accountLayer", "accountLayer", 2);
	core.diamond = { facets: [{ code: `0x60${id("SIGNER_ADMIN_ROLE").slice(2)}` }] };
	const edges = await inspectRoleConnections({
		nodes: [core, al],
		profile: { version: "0.8.6.2" },
		read: async (_to, signature) => {
			if (signature.includes("hasRole") || signature.includes("isRoleAdmin")) return false;
			throw Error("unsupported");
		},
	});
	assert.ok(!edges.some(e => e.label === "AFFILIATE_REGISTRAR_ROLE"));
	assert.ok(edges.some(e => e.label === "SIGNER_ADMIN_ROLE" && e.status === "missing"));
});

test("unavailable deployed guard evidence is unknown, while explicit profile requirements remain authoritative", async () => {
	const core = node("core", "core", 1),
		il = node("instantLayer", "instantLayer", 2);
	core.observedAt = 100;
	const read = async (_to, signature) => {
		if (signature.includes("hasRole") || signature.includes("isRoleAdmin")) return false;
		throw Error("unsupported");
	};
	const run = profile => inspectRoleConnections({ nodes: [core, il], profile, read });
	const discovered = await run({});
	assert.equal(discovered.find(e => e.from === "instantLayer" && e.to === "core").status, "unknown");
	const explicit = await run({ expectedRoles: [{ holder: "instantLayer", contract: "core", role: "INSTANT_LAYER_ROLE" }] });
	assert.equal(explicit.find(e => e.from === "instantLayer" && e.to === "core").status, "missing");
});

test("deployed Express selectors choose legacy role order and expose missing administrator introspection", async () => {
	const express = node("express", "express", 1),
		holder = node("operator", "authority", 2);
	express.diamond = { facets: [{ selectors: [id("hasRole(bytes32,address)").slice(0, 10)], code: "0x" }] };
	let wrongReads = 0;
	const edges = await inspectRoleConnections({
		nodes: [express, holder],
		profile: {},
		read: async (_target, signature, args) => {
			if (signature.includes("hasRole(bytes32,address)")) return args[0] === id("OPERATOR_ROLE") && args[1] === holder.address;
			if (signature.includes("hasRole(address") || signature.includes("isRoleAdmin")) wrongReads++;
			throw Error("unsupported");
		},
	});
	assert.equal(wrongReads, 0);
	assert.equal(express.roleReadFailures || 0, 0);
	assert.equal(express.adminReadFailures, 1);
	assert.ok(edges.some(e => e.from === holder.id && e.to === express.id && e.label === "OPERATOR_ROLE" && e.status === "verified"));
});

test("discovered governance Safe signer addresses have their own edges", async () => {
	const safe = node("governance", "authority", 1);
	safe.state.owners = [address(2), address(3)];
	safe.state.threshold = 2;
	const nodes = [safe],
		edges = [];
	await inspectDependencies({
		nodes,
		edges,
		read: async () => {
			throw Error("unsupported");
		},
	});
	assert.equal(edges.filter(e => e.to === safe.id && e.label === "Safe owner" && e.status === "verified").length, 2);
	assert.ok(nodes.some(n => n.address === address(2)));
});

test("a different configured pointer stays green while the expected destination is red", () => {
	const expected = node("instantLayer", "instantLayer", 2);
	const edges = pointerConnections("gasless", "replacement", "instantLayer", address(3), expected);
	assert.deepEqual(
		edges.map(e => [e.to, e.status]),
		[
			["replacement", "verified"],
			["instantLayer", "mismatch"],
		],
	);
	assert.equal(pointerConnections("gasless", expected.id, "instantLayer", expected.address, expected).length, 1);
});
