import { graphModel, LAYOUT, linkId, semanticLayout } from "../shared/graph-model.js";
import { changeView, filterView, findContracts, looksLikeAddress, mapView, placeNodes, scopeKey, stacksOf } from "../shared/map-view.js";
import assert from "node:assert/strict";
import test from "node:test";

const node = (id, kind, name = id) => ({ id, kind, name, address: `0x${id.padStart(40, "0")}`, status: "observed", state: {}, errors: [] });
const edge = (from, to, label, kind = "role", status = "verified") => ({ from, to, label, kind, status });
const filters = (change = {}) => ({ mode: "all", focus: "", query: "", missingOnly: false, hide: [], ...change });

// Core is owned by a Safe whose signer is a wallet; an operator holds a role; one grant is missing.
const snapshot = {
	nodes: [
		node("core", "core", "Symmio"),
		node("safe", "safe", "Main Multisig"),
		node("signer", "authority", "Signer"),
		node("op1", "authority", "Operator"),
		node("op2", "authority", "Operator"),
		node("op3", "authority", "Operator"),
		node("verifier", "verifier", "Verifier"),
		node("idle", "authority", "Listed wallet"),
	],
	edges: [
		edge("safe", "core", "owner", "ownership"),
		edge("signer", "safe", "signer", "ownership"),
		...["op1", "op2", "op3"].map(id => edge(id, "core", "OPERATOR_ROLE")),
		edge("verifier", "core", "SETTER_ROLE", "role", "missing"),
		edge("core", "verifier", "getSignatureVerifier", "pointer"),
	],
};

test("the chain from snapshot to drawing reports what it draws", () => {
	const view = mapView({ snapshot, filters: filters() });
	// The three operators are wired alike and become one stack; everything else is its own node.
	assert.equal(view.stacks.size, 1);
	assert.equal(view.tally.nodes, snapshot.nodes.length - 2);
	assert.equal(view.tally.addresses, snapshot.nodes.length);
	assert.equal(view.tally.connections, snapshot.edges.length);
	assert.equal(view.tally.of, snapshot.edges.length);
	assert.equal(view.tally.issues, 1);
	for (const section of view.layout.sections) assert.ok(view.positions[`lane:${section.name}`], `lane ${section.name} has a place`);
	const lane = view.positions[`lane:${view.layout.sections[0].name}`];
	assert.ok(
		Object.values(view.layout.positions).every(p => p.y - lane.y >= LAYOUT.row / 2),
		"lane names sit above every row",
	);
	// Turning stacking off draws every address on its own.
	assert.equal(mapView({ snapshot, filters: filters(), stacking: false }).tally.nodes, snapshot.nodes.length);
});

test("with nothing to stack the same model is kept, whatever is selected", () => {
	const lone = {
		nodes: snapshot.nodes.filter(n => !n.id.startsWith("op") && n.id !== "idle"),
		edges: snapshot.edges.filter(e => !e.from.startsWith("op")),
	};
	const { base } = filterView(lone, filters());
	const a = mapView({ snapshot: lone, filters: filters(), selected: "core" }),
		b = mapView({ snapshot: lone, filters: filters(), selected: "verifier" });
	assert.equal(a.stacks.size, 0);
	assert.deepEqual(a.model, b.model);
	assert.deepEqual(stacksOf(base), { stacks: new Map(), memberOf: new Map() });
});

test("a question is drawn in full even when the filters would hide it", () => {
	const reach = { id: "core", direction: "under" };
	// Issues only keeps the missing grant alone, and hiding owners drops the Safe and its signer.
	for (const change of [{ missingOnly: true }, { hide: ["ownership", "integration"] }, { query: "verifier" }]) {
		const view = mapView({ snapshot, filters: filters(change), reach, stacking: false });
		for (const id of ["safe", "signer", "op1"]) assert.ok(view.lit.nodes.has(id), `${id} is lit with ${JSON.stringify(change)}`);
		for (const link of [linkId("safe", "core"), linkId("signer", "safe"), linkId("op1", "core")])
			assert.ok(
				view.links.some(l => l.id === link),
				`${link} is drawn with ${JSON.stringify(change)}`,
			);
		assert.equal(view.answer.total, 5);
		assert.ok(view.answer.outside > 0, "the drawing says how much of the answer the filters would have hidden");
	}
	// Without filters nothing is drawn only because of the question.
	assert.equal(mapView({ snapshot, filters: filters(), reach }).answer.outside, 0);
	// One contract's neighbourhood keeps to that contract.
	assert.equal(mapView({ snapshot, filters: filters({ focus: "verifier" }), reach }).answer.total, 0);
});

test("the change view lights what changed and leaves the rest", () => {
	const delta = [
		{ kind: "connection", node: "op1", to: "core", edgeKind: "role", label: "OPERATOR_ROLE", before: null, after: { status: "verified" } },
	];
	assert.equal(changeView(snapshot, delta, false).showChanges, false);
	const view = mapView({ snapshot, delta, filters: filters(), changes: true });
	assert.equal(view.showChanges, true);
	assert.ok(view.lit.nodes.has("op1") && view.lit.nodes.has("core"));
	assert.ok(!view.lit.nodes.has("verifier"));
});

test("a search finds a contract that has no connections, by name, alias or address", () => {
	const byName = graphModel(snapshot, { query: "listed" });
	assert.deepEqual(
		byName.nodes.map(n => n.id),
		["idle"],
	);
	assert.equal(byName.edges.length, 0);
	assert.deepEqual(
		graphModel(snapshot, { query: snapshot.nodes[7].address.slice(-10) }).nodes.map(n => n.id),
		["idle"],
	);
	// One contract's neighbourhood stays its neighbourhood.
	assert.equal(
		graphModel(snapshot, { query: "listed", focus: "core" }).nodes.some(n => n.id === "idle"),
		false,
	);
	const aliased = [...snapshot.nodes, { ...node("gate", "external", "Hook"), aliases: ["Oracle gate"] }];
	assert.deepEqual(
		findContracts(aliased, "oracle").map(n => n.id),
		["gate"],
	);
	// Best first: an exact name, then one that starts with the text, then one that contains it.
	assert.deepEqual(
		findContracts([node("a", "external", "Main Symmio"), node("b", "external", "Symmio helper"), node("c", "core", "Symmio")], "symmio").map(
			n => n.id,
		),
		["c", "b", "a"],
	);
	assert.deepEqual(
		findContracts(snapshot.nodes, snapshot.nodes[1].address).map(n => n.id),
		["safe"],
	);
	assert.equal(looksLikeAddress("0x12ab"), true);
	assert.equal(looksLikeAddress("0x"), false);
	assert.equal(looksLikeAddress("Symmio"), false);
});

test("the map is fitted again only when what it is drawn around changes", () => {
	const base = scopeKey(filters());
	assert.equal(scopeKey(filters({ hide: ["ownership"] })), base, "a filter chip keeps the view");
	assert.notEqual(scopeKey(filters({ focus: "core" })), base);
	assert.notEqual(scopeKey(filters({ query: "x" })), base);
	assert.equal(scopeKey(filters({ query: " X " })), scopeKey(filters({ query: "x" })));
	assert.notEqual(scopeKey(filters({ missingOnly: true })), base);
	assert.notEqual(scopeKey(filters({ mode: "implementation" })), base);
});

const overlaps = positions => {
	const placed = Object.entries(positions);
	for (let i = 0; i < placed.length; i++)
		for (let j = i + 1; j < placed.length; j++) {
			const [a, p] = placed[i],
				[b, q] = placed[j];
			if (Math.abs(p.x - q.x) < LAYOUT.column - 12 && Math.abs(p.y - q.y) < LAYOUT.row - 16) return `${a} overlaps ${b}`;
		}
	return "";
};

test("selecting a stacked address places it beside its stack and leaves the lane as it was", () => {
	const crowd = {
		nodes: [
			node("core", "core", "Symmio"),
			...Array.from({ length: 12 }, (_, i) => node(`w${i}`, "authority", i < 4 ? "Relayer" : `Wallet ${i}`)),
		],
		edges: Array.from({ length: 12 }, (_, i) => edge(`w${i}`, "core", i < 4 ? "RELAYER_ROLE" : `ROLE_${i}`)),
	};
	const before = mapView({ snapshot: crowd, filters: filters() }),
		after = mapView({ snapshot: crowd, filters: filters(), selected: "w0" });
	const drawn = placeNodes(before.model.nodes, before.layout.positions, null);
	assert.deepEqual(drawn, before.layout.positions);
	const [stack] = before.stacks.values();
	const next = placeNodes(after.model.nodes, after.layout.positions, { positions: drawn, memberOf: before.memberOf });
	// Every contract that was already drawn stays exactly where it was.
	for (const n of before.model.nodes) if (next[n.id]) assert.deepEqual(next[n.id], drawn[n.id], `${n.id} kept its place`);
	// The rest of the stack takes the old stack's place; the selected address goes beside it, overlapping nothing.
	const [rest] = after.stacks.values();
	assert.deepEqual(next[rest.id], drawn[stack.id]);
	assert.equal(overlaps(next), "");
	const away = Math.abs(next.w0.x - drawn[stack.id].x) / LAYOUT.column + Math.abs(next.w0.y - drawn[stack.id].y) / LAYOUT.row;
	assert.ok(away <= 9, `the address is placed near its stack (${away} steps away)`);
	// Selecting something else folds it back in, onto the same place.
	const back = placeNodes(before.model.nodes, before.layout.positions, { positions: next, memberOf: after.memberOf });
	assert.deepEqual(back[stack.id], drawn[stack.id]);
	assert.equal(overlaps(back), "");
});

test("a dragged contract keeps its place, and a new one avoids it", () => {
	const nodes = [node("core", "core"), node("a", "authority"), node("b", "authority")],
		fresh = semanticLayout(nodes).positions,
		previous = { positions: { core: fresh.core, a: { x: fresh.b.x, y: fresh.b.y } } };
	const next = placeNodes(nodes, fresh, previous);
	assert.deepEqual(next.a, fresh.b, "the dragged contract stays where it was put");
	assert.notDeepEqual(next.b, fresh.b, "the new contract does not land on it");
	assert.equal(overlaps(next), "");
});
