import { suppliedProfile, systemDiff } from "../server/system.js";
import { createWorkspace } from "../server/workspace.js";
import { changeOverlay, power, stackModel, withChanges } from "../shared/graph-insight.js";
import { bundleEdges, graphModel } from "../shared/graph-model.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const node = (id, kind, name = id) => ({ id, kind, name, address: `0x${id}`, status: "observed", state: {}, errors: [] });
const edge = (from, to, label, kind = "role", status = "verified") => ({ from, to, label, kind, status });

test("wallets wired identically are drawn as one stack, and every connection still says whose it is", () => {
	const nodes = [
		node("core", "core", "Symmio"),
		node("liquidator", "liquidator", "Liquidator Proxy"),
		node("op1", "authority", "Liquidator operator"),
		node("op2", "authority", "Liquidator operator"),
		node("op3", "authority", "Liquidator operator"),
		node("admin", "authority", "Admin authority"),
		node("odd", "authority", "Role holder"),
		node("idle", "authority", "Withdraw operator"),
		node("idle2", "authority", "Withdraw operator"),
		node("spare", "authority", "Symbol operator"),
		node("d1", "external", "Referenced address"),
		node("d2", "external", "Referenced address"),
	];
	const edges = [
		...["op1", "op2", "op3"].map(id => edge(id, "liquidator", "TRUSTED_ROLE")),
		edge("admin", "core", "DEFAULT_ADMIN_ROLE"),
		edge("odd", "liquidator", "TRUSTED_ROLE"),
		edge("odd", "core", "PAUSER_ROLE"),
		edge("core", "d1", "getAllDistributors[0]", "pointer"),
		edge("core", "d2", "getAllDistributors[3]", "pointer"),
	];
	const model = graphModel({ nodes, edges }),
		stacked = stackModel(model);
	const [stack, idle, listed] = stacked.stacks.values();
	assert.equal(stacked.stacks.size, 3);
	assert.deepEqual(
		{ name: stack.name, kind: stack.kind, summary: stack.summary, members: stack.members.map(m => m.id) },
		{ name: "3 × Liquidator operator", kind: "authority", summary: "TRUSTED_ROLE", members: ["op1", "op2", "op3"] },
	);
	// One node where there were three; the wallet with an extra role stays itself.
	assert.deepEqual(
		stacked.nodes.map(n => n.id),
		["core", "liquidator", stack.id, "admin", "odd", idle.id, "spare", listed.id],
	);
	// Listed operators that hold nothing stack with others of the same name, and only with those.
	assert.deepEqual([idle.name, idle.summary], ["2 × Withdraw operator", "no connections"]);
	// The same pointer at two places in a list is the same wiring.
	assert.deepEqual([listed.name, listed.members.map(m => m.id)], ["2 × Referenced address", ["d1", "d2"]]);
	const [link] = bundleEdges(stacked.edges).filter(l => l.from === stack.id);
	assert.equal(link.count, 3);
	assert.deepEqual(link.edges.map(e => e.fromMember).sort(), ["op1", "op2", "op3"]);
	assert.equal(stacked.memberOf.get("op2"), stack.id);

	// The contract being looked at is never hidden inside a stack, and a stack opened by hand stays open.
	assert.deepEqual([...stackModel(model, { keep: ["op2"] }).stacks.values()].map(s => s.members.map(m => m.id))[0], ["op1", "op3"]);
	assert.equal(stackModel(model, { expanded: [stack.id] }).stacks.has(stack.id), false);
	// Protocol contracts are never stacked, however alike their wiring.
	const twins = graphModel({
		nodes: [node("core", "core"), node("a", "partyB"), node("b", "partyB")],
		edges: [edge("a", "core", "X_ROLE"), edge("b", "core", "X_ROLE")],
	});
	// With nothing to stack the model comes back as it was, so a view drawn from it need not be redrawn.
	assert.equal(stackModel(twins), twins);
	assert.equal(stackModel(twins, { keep: ["a"] }), twins);
	// Wallets under different names still stack, under a plain count.
	const mixed = graphModel({
		nodes: [node("core", "core"), node("a", "authority", "Role holder"), node("b", "authority", "Operator")],
		edges: [edge("a", "core", "X_ROLE"), edge("b", "core", "X_ROLE"), edge("a", "core", "Y_ROLE"), edge("b", "core", "Y_ROLE")],
	});
	const [both] = stackModel(mixed).stacks.values();
	assert.deepEqual([both.name, both.summary], ["2 wallets", "2 connections each"]);
});

test("power follows confirmed roles, role admins and ownership, and continues through a Safe", () => {
	const snapshot = {
		nodes: [
			node("core", "core", "Symmio"),
			node("instantLayer", "instantLayer"),
			node("safe", "safe", "Governance Safe"),
			node("alice", "authority"),
			node("bot", "authority"),
			node("token", "token"),
		],
		edges: [
			edge("safe", "core", "DEFAULT_ADMIN_ROLE"),
			edge("safe", "core", "Admin · PAUSER_ROLE", "roleAdmin"),
			edge("safe", "instantLayer", "Owner", "ownership"),
			edge("alice", "safe", "Safe owner", "ownership"),
			edge("bot", "core", "PAUSER_ROLE"),
			// Not power: a role the chain says is not held, and a plain pointer.
			edge("bot", "instantLayer", "OPERATOR_ROLE", "role", "missing"),
			edge("core", "token", "getCollateral", "pointer"),
		],
	};
	const brief = result =>
		result.entries.map(
			e =>
				`${e.node}${e.via.length ? ` via ${e.via.join(">")}` : ""}: holds ${e.holds.length}, grants ${e.grants.length}, owns ${e.owns.length}`,
		);
	// What Alice can change: the Safe she co-owns, and through it everything the Safe can.
	const alice = power(snapshot, "alice", "over");
	assert.deepEqual(brief(alice), [
		"safe: holds 0, grants 0, owns 1",
		"instantLayer via safe: holds 0, grants 0, owns 1",
		"core via safe: holds 1, grants 1, owns 0",
	]);
	assert.deepEqual([...alice.nodes].sort(), ["alice", "core", "instantLayer", "safe"]);
	assert.deepEqual([...alice.links].sort(), ["alice>safe", "safe>core", "safe>instantLayer"]);
	assert.deepEqual(alice.entries.find(e => e.node === "core").grants, ["PAUSER_ROLE"]);
	// Who can change the core: the Safe and the bot directly, and Alice through the Safe.
	assert.deepEqual(brief(power(snapshot, "core", "under")), [
		"safe: holds 1, grants 1, owns 0",
		"bot: holds 1, grants 0, owns 0",
		"alice via safe: holds 0, grants 0, owns 1",
	]);
	// The unheld role gives the bot nothing over the Instant Layer, and a pointer gives the core nothing over the token.
	assert.deepEqual(brief(power(snapshot, "bot", "over")), ["core: holds 1, grants 0, owns 0"]);
	assert.deepEqual(power(snapshot, "token", "under").entries, []);
	assert.deepEqual(power(snapshot, "core", "over").entries, []);
});

test("the change list becomes marks on the map: new, altered and gone, without the counters", () => {
	const before = {
		nodes: [
			{ ...node("core", "core", "Symmio"), state: { nextQuoteId: "7" } },
			{ ...node("instantLayer", "instantLayer", "Instant Layer"), address: "0xold" },
			node("retired", "authority", "Old operator"),
		],
		edges: [
			edge("instantLayer", "core", "INSTANT_LAYER_ROLE"),
			edge("retired", "core", "PAUSER_ROLE"),
			{ ...edge("core", "instantLayer", "Whitelisted target", "membership"), actual: false, status: "missing" },
		],
	};
	const after = {
		nodes: [
			{ ...node("core", "core", "Symmio"), state: { nextQuoteId: "9" } },
			{ ...node("instantLayer", "instantLayer", "Instant Layer"), address: "0xnew" },
			node("fresh", "authority", "New operator"),
		],
		edges: [
			edge("instantLayer", "core", "INSTANT_LAYER_ROLE"),
			edge("fresh", "core", "PAUSER_ROLE"),
			{ ...edge("core", "instantLayer", "Whitelisted target", "membership"), actual: true },
		],
	};
	const delta = systemDiff(before, after);
	assert.deepEqual(
		delta.map(d => `${d.kind} ${d.node} ${d.field}`),
		[
			"state core nextQuoteId",
			"contract instantLayer address",
			"contract fresh contract",
			"contract retired contract",
			"connection retired PAUSER_ROLE → core",
			"connection core Whitelisted target → instantLayer",
			"connection fresh PAUSER_ROLE → core",
		],
	);
	const overlay = changeOverlay(after, delta);
	assert.deepEqual(
		[...overlay.nodes],
		[
			["instantLayer", "changed"],
			["fresh", "added"],
		],
	);
	assert.deepEqual(
		overlay.ghosts.map(g => [g.id, g.name, g.kind, g.removed]),
		[["retired", "Old operator", "authority", true]],
	);
	// The counter that moved is not a change to the wiring.
	assert.equal(overlay.count, 6);
	const marked = withChanges(after, overlay),
		links = Object.fromEntries(bundleEdges(graphModel(marked).edges).map(l => [l.id, l.diff])),
		model = graphModel(marked);
	assert.deepEqual(links, { "instantLayer>core": undefined, "fresh>core": "added", "core>instantLayer": "changed", "retired>core": "removed" });
	assert.deepEqual(
		model.nodes.map(n => [n.id, n.diff || (n.removed ? "removed" : "")]),
		[
			["core", ""],
			["instantLayer", "changed"],
			["fresh", "added"],
			["retired", "removed"],
		],
	);
	// What is gone is history: it is drawn, but it is not counted as something wrong now.
	assert.equal(model.tally.issues, 0);
	// With nothing recorded the snapshot comes back as it was.
	assert.deepEqual(withChanges(after, changeOverlay(after, [])).edges, after.edges);
	// Wallets that changed are not hidden in a stack with ones that did not.
	const crowd = {
		nodes: [node("core", "core"), node("a", "authority", "Op"), node("b", "authority", "Op"), node("c", "authority", "Op")],
		edges: ["a", "b", "c"].map(id => edge(id, "core", "X_ROLE")),
	};
	const grown = changeOverlay(crowd, [
		{ kind: "connection", node: "c", to: "core", label: "X_ROLE", edgeKind: "role", before: null, after: { status: "verified" } },
	]);
	assert.deepEqual(
		[...stackModel(graphModel(withChanges(crowd, grown))).stacks.values()].map(s => s.members.map(m => m.id)),
		[["a", "b"]],
	);
	// New wallets stack with each other, apart from the ones that were already there, and the stack says it is new.
	const arrivals = changeOverlay(crowd, [
		{ kind: "contract", node: "b", field: "contract", before: null, after: "0xb" },
		{ kind: "contract", node: "c", field: "contract", before: null, after: "0xc" },
		...["b", "c"].map(id => ({
			kind: "connection",
			node: id,
			to: "core",
			label: "X_ROLE",
			edgeKind: "role",
			before: null,
			after: { status: "verified" },
		})),
	]);
	assert.deepEqual(
		[...stackModel(graphModel(withChanges(crowd, arrivals))).stacks.values()].map(s => [s.members.map(m => m.id), s.diff]),
		[[["b", "c"], "added"]],
	);
});

test("the change list is kept beside the snapshot it describes, and only used for that snapshot", () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-changes-"));
	const name = kind => path.join(stateRoot, `${kind}-${suppliedProfile.chainId}-${suppliedProfile.id}.json`);
	const snapshot = {
		chainId: suppliedProfile.chainId,
		blockNumber: 200,
		at: "2026-10-12T00:00:00Z",
		profile: suppliedProfile,
		nodes: [],
		edges: [],
	};
	const delta = [{ kind: "contract", node: "instantLayer", name: "Instant Layer", field: "address", before: "0xold", after: "0xnew" }];
	fs.writeFileSync(name("snapshot"), JSON.stringify(snapshot));
	// No file yet: a first inspection has nothing to compare with.
	assert.deepEqual([createWorkspace({ stateRoot }).status().delta, createWorkspace({ stateRoot }).status().since], [[], null]);
	fs.writeFileSync(name("changes"), JSON.stringify({ since: { blockNumber: 100, at: "2026-10-11T00:00:00Z" }, to: 200, delta }));
	const restored = createWorkspace({ stateRoot }).status();
	assert.deepEqual(restored.delta, delta);
	assert.deepEqual(restored.since, { blockNumber: 100, at: "2026-10-11T00:00:00Z" });
	// A list measured against another read says nothing about this one.
	fs.writeFileSync(name("changes"), JSON.stringify({ since: { blockNumber: 100 }, to: 150, delta }));
	assert.deepEqual(createWorkspace({ stateRoot }).status().delta, []);
});
