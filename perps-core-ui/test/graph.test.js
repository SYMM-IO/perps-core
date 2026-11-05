import { inspectRoleConnections, roleHash } from "../server/roles.js";
import { graphModel, semanticLayout, bundleEdges, linkId, LAYOUT } from "../shared/graph-model.js";
import { id, ZeroHash } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const address = index => `0x${index.toString(16).padStart(40, "0")}`;
const node = (id, kind, index, roles) => ({ id, kind, name: id, address: address(index), status: "observed", state: roles ? { roles } : {} });
test("role discovery keeps separate grants, expected missing grants and failed reads distinct", async () => {
	const nodes = [
		node("core", "core", 1),
		node("instantLayer", "instantLayer", 2),
		node("accountLayer", "accountLayer", 3),
		node("governance", "authority", 4),
		node("partyB", "partyB", 5),
	];
	nodes[1].state.roles = { DEFAULT_ADMIN_ROLE: [address(4)], SETTER_ROLE: [address(4)], OPERATOR_ROLE: [address(5)] };
	const edges = await inspectRoleConnections({
		nodes,
		profile: {},
		read: async (contract, signature, args) => {
			const diamond = signature.includes("hasRole(address");
			const [holder, role] = diamond ? args : [args[1], args[0]];
			if (contract === address(5) && holder === address(2) && role === id("TRUSTED_ROLE")) throw new Error("RPC unavailable");
			return contract === address(1) && holder === address(2) && role === id("INSTANT_LAYER_ROLE");
		},
	});
	assert.equal(edges.find(e => e.from === "instantLayer" && e.to === "core").status, "verified");
	assert.equal(edges.find(e => e.to === "accountLayer" && e.label === "SIGNER_SETTER_ROLE").status, "missing");
	assert.equal(edges.find(e => e.to === "partyB" && e.label === "TRUSTED_ROLE").status, "unknown");
	assert.equal(
		edges.find(e => e.to === "accountLayer" && e.label === "INSTANT_LAYER_ROLE"),
		undefined,
		"unused AccountLayer role must not be presented as a missing integration grant",
	);
	assert.equal(edges.filter(e => e.from === "governance" && e.to === "instantLayer").length, 2);
	assert.equal(edges.filter(e => e.to === "core" && e.status === "missing").length, 0, "unrequired absent grants are not defects");
	assert.equal(roleHash("core", "DEFAULT_ADMIN_ROLE"), id("DEFAULT_ADMIN_ROLE"));
	assert.equal(roleHash("verifier", "DEFAULT_ADMIN_ROLE"), ZeroHash);
	const graph = graphModel({ nodes, edges }, { mode: "roles" });
	assert.equal(graph.edges.length, edges.length);
	assert.equal(new Set(graph.edges.map(e => e.id)).size, edges.length);
	assert.equal(graph.edges.find(e => e.status === "unknown").state, "unknown");
});

test("graph retains parallel and reverse edges, external references and focused missing state", () => {
	const nodes = [node("a", "core", 1), node("b", "instantLayer", 2)];
	const edges = [
		{ from: "a", to: "b", label: "SETTER_ROLE", kind: "role", status: "verified" },
		{ from: "a", to: "b", label: "OPERATOR_ROLE", kind: "role", status: "missing" },
		{ from: "b", to: "a", label: "INSTANT_LAYER_ROLE", kind: "role", status: "unknown" },
		{ from: "a", to: `address:${address(3)}`, label: "getSignatureVerifier", kind: "pointer", status: "mismatch", actual: address(3) },
	];
	const all = graphModel({ nodes, edges }, { mode: "all" });
	assert.equal(all.edges.length, 4);
	assert.equal(all.nodes.length, 3);
	const filtered = graphModel({ nodes, edges }, { mode: "roles", focus: "b", missingOnly: true });
	assert.deepEqual(
		filtered.edges.map(e => e.label),
		["OPERATOR_ROLE", "INSTANT_LAYER_ROLE"],
	);
});

test("automatic layout keeps semantic lane order, stable positions and separated nodes", () => {
	const nodes = [
		node("core", "core", 1),
		node("al", "accountLayer", 2),
		node("instant", "instantLayer", 3),
		node("verifier", "verifier", 4),
		node("affiliate", "affiliate", 5),
		...Array.from({ length: 24 }, (_, i) => node(`admin-${i}`, "authority", i + 10)),
	];
	const layout = semanticLayout(nodes),
		positions = layout.positions;
	assert.deepEqual(semanticLayout([...nodes].reverse()), layout);
	for (const n of nodes.filter(n => n.kind === "authority")) assert.ok(positions[n.id].x < positions.instant.x);
	assert.ok(positions.instant.x < positions.core.x);
	assert.equal(positions.core.x, positions.al.x);
	assert.ok(positions.core.x < positions.verifier.x && positions.verifier.x < positions.affiliate.x);
	for (let i = 0; i < nodes.length; i++)
		for (let j = i + 1; j < nodes.length; j++) {
			const a = positions[nodes[i].id],
				b = positions[nodes[j].id];
			assert.ok(Math.abs(a.x - b.x) >= LAYOUT.column || Math.abs(a.y - b.y) >= LAYOUT.row, `${nodes[i].id} overlaps ${nodes[j].id}`);
		}
	const details = semanticLayout([node("library", "library", 1), node("facet", "facet", 2), node("core", "core", 3)], {
		implementation: true,
	}).positions;
	assert.ok(details.core.x < details.facet.x && details.facet.x < details.library.x);
});

test("links draw one line per ordered pair and keep every grant, count and worst state", () => {
	const nodes = [node("a", "authority", 1), node("b", "core", 2)];
	const edges = [
		{ from: "a", to: "b", label: "SETTER_ROLE", kind: "role", status: "verified" },
		{ from: "a", to: "b", label: "OPERATOR_ROLE", kind: "role", status: "missing" },
		{ from: "a", to: "b", label: "Admin · SETTER_ROLE", kind: "roleAdmin", status: "verified" },
		{ from: "b", to: "a", label: "owner", kind: "pointer", status: "verified" },
	];
	const model = graphModel({ nodes, edges }, { mode: "all" }),
		links = bundleEdges(model.edges);
	assert.deepEqual(
		links.map(l => l.id),
		[linkId("a", "b"), linkId("b", "a")],
	);
	const [forward, reverse] = links;
	assert.equal(forward.count, 3);
	assert.equal(forward.state, "missing");
	assert.equal(forward.label, "3 connections · 1 missing");
	assert.equal(forward.edges[0].label, "OPERATOR_ROLE", "the failing grant is listed first");
	assert.deepEqual(forward.edges.map(e => e.label).sort(), ["Admin · SETTER_ROLE", "OPERATOR_ROLE", "SETTER_ROLE"]);
	assert.equal(reverse.label, "owner");
	assert.equal(reverse.state, "set");
	assert.equal(
		links.reduce((sum, l) => sum + l.count, 0),
		model.edges.length,
		"no connection is dropped by bundling",
	);
	assert.equal(bundleEdges([{ from: "a", to: "b", label: "x", status: "unknown" }])[0].state, "unknown");
});

test("compact layout groups the lanes around Core without overlapping or reordering them", () => {
	const nodes = [
		node("gov", "authority", 1),
		node("gasless", "gasless", 2),
		node("core", "core", 3),
		node("al", "accountLayer", 4),
		...Array.from({ length: 5 }, (_, i) => node(`service-${i}`, "verifier", i + 10)),
		...Array.from({ length: 5 }, (_, i) => node(`affiliate-${i}`, "affiliate", i + 20)),
	];
	const { positions, sections } = semanticLayout(nodes, { compact: true });
	assert.deepEqual(
		sections.map(s => s.name),
		["Governance · Execution", "Core & accounts", "Services · Affiliates & external"],
	);
	assert.deepEqual(semanticLayout([...nodes].reverse(), { compact: true }).positions, positions);
	assert.ok(positions.gov.x === positions.gasless.x && positions.gov.y < positions.gasless.y, "governance sits above execution");
	assert.ok(positions.gov.x < positions.core.x && positions.core.x < positions["service-0"].x);
	assert.ok(positions["service-0"].x < positions["affiliate-4"].x, "services stay left of affiliates");
	const placed = Object.values(positions);
	for (let i = 0; i < placed.length; i++)
		for (let j = i + 1; j < placed.length; j++)
			assert.ok(Math.abs(placed[i].x - placed[j].x) >= LAYOUT.column || Math.abs(placed[i].y - placed[j].y) >= LAYOUT.row);
	assert.equal(semanticLayout(nodes).sections.length, 5, "the whole-system view keeps one lane per role");
});

test("filter groups hide connections without moving contracts, and their counts ignore what is hidden", () => {
	const nodes = [
		node("core", "core", 1),
		node("gov", "authority", 2),
		node("il", "instantLayer", 3),
		node("verifier", "verifier", 4),
		node("idle", "token", 5),
	];
	const edges = [
		{ from: "il", to: "core", label: "INSTANT_LAYER_ROLE", kind: "role", status: "verified" },
		{ from: "gov", to: "core", label: "SETTER_ROLE", kind: "role", status: "verified" },
		{ from: "gov", to: "core", label: "Admin · SETTER_ROLE", kind: "roleAdmin", status: "verified" },
		{ from: "gov", to: "core", label: "owner", kind: "ownership", status: "verified" },
		{ from: "core", to: "verifier", label: "getSignatureVerifier", kind: "pointer", status: "mismatch" },
	];
	const all = graphModel({ nodes, edges });
	assert.deepEqual(all.tally, { groups: { integration: 1, grant: 1, roleAdmin: 1, ownership: 1, wiring: 1 }, issues: 1, total: 5 });
	assert.deepEqual(
		all.edges.map(e => e.group),
		["integration", "grant", "roleAdmin", "ownership", "wiring"],
	);

	const hidden = graphModel({ nodes, edges }, { hide: ["grant", "roleAdmin", "ownership"] });
	assert.deepEqual(
		hidden.edges.map(e => e.label),
		["INSTANT_LAYER_ROLE", "getSignatureVerifier"],
	);
	// A chip's number says what switching it on would add, so it cannot depend on the chips that are off.
	assert.deepEqual(hidden.tally, all.tally);
	// Governance lost every line but keeps its place; so does the contract that never had one.
	assert.deepEqual(
		hidden.nodes.map(n => n.id),
		all.nodes.map(n => n.id),
	);
	assert.deepEqual(semanticLayout(hidden.nodes).positions, semanticLayout(all.nodes).positions);

	// The search matches a contract by name or address as well as a role or getter by label.
	const byName = graphModel({ nodes, edges }, { query: "Verif" });
	assert.deepEqual(
		byName.edges.map(e => e.label),
		["getSignatureVerifier"],
	);
	assert.deepEqual(byName.nodes.map(n => n.id).sort(), ["core", "verifier"]);
	assert.equal(byName.tally.total, 1);
	assert.deepEqual(
		graphModel({ nodes, edges }, { query: address(3).slice(-8) }).edges.map(e => e.label),
		["INSTANT_LAYER_ROLE"],
	);
	assert.deepEqual(
		graphModel({ nodes, edges }, { query: "setter" }).edges.map(e => e.label),
		["SETTER_ROLE", "Admin · SETTER_ROLE"],
	);
	// A contract is also found by another label it goes by, kept as an alias.
	const aliased = nodes.map(n => (n.id === "verifier" ? { ...n, aliases: ["Oracle Gate"] } : n));
	assert.deepEqual(
		graphModel({ nodes: aliased, edges }, { query: "oracle gate" }).edges.map(e => e.label),
		["getSignatureVerifier"],
	);
});
