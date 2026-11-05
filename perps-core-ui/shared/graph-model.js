export const isImplementation = kind => ["facet", "implementation", "library"].includes(kind);
export const edgeKind = edge => edge.kind || (edge.label.endsWith("_ROLE") ? "role" : "pointer");
export const edgeStatus = edge => (["missing", "mismatch"].includes(edge.status) ? "missing" : edge.status === "verified" ? "set" : "unknown");
// What a connection is for. The map's filter chips show or hide these one group at a time.
export const EDGE_GROUPS = [
	{ id: "integration", label: "Integration roles" },
	{ id: "grant", label: "Admin grants" },
	{ id: "roleAdmin", label: "Role admins" },
	{ id: "ownership", label: "Owners & signers" },
	{ id: "wiring", label: "Pointers & hooks" },
];
export function edgeGroup(edge, nodes) {
	const kind = edgeKind(edge);
	if (kind === "role") return nodes.get(edge.from)?.kind === "authority" ? "grant" : "integration";
	if (kind === "roleAdmin") return "roleAdmin";
	return kind === "ownership" || kind === "membership" ? "ownership" : "wiring";
}
// A connection that is gone is history, shown only when the map is asked for changes.
const isOpenIssue = edge => edge.state !== "set" && edge.status !== "unset" && !edge.removed;
/**
 * @param {{ nodes: any[], edges: any[] }} snapshot
 * @param {{ mode?: string, focus?: string, missingOnly?: boolean, query?: string, hide?: string[] }} [filters]
 */
export function graphModel(snapshot, { mode = "all", focus = "", missingOnly = false, query = "", hide = [] } = {}) {
	const nodes = new Map(snapshot.nodes.map(n => [n.id, n]));
	const text = query.trim().toLowerCase();
	// A search finds a connection by its own name or by either contract it joins, under any name that contract goes by.
	const named = id => {
		const node = nodes.get(id);
		return `${node?.name || ""} ${(node?.aliases || []).join(" ")} ${node?.address || ""} ${id}`.toLowerCase();
	};
	// Everything the current view, search and neighbourhood could show. The chips count this set,
	// so a count always says what turning that chip on would add.
	const scoped = snapshot.edges
		.map((edge, index) => ({ ...edge, id: `connection-${index}`, kind: edgeKind(edge), state: edgeStatus(edge) }))
		.filter(edge => {
			if (mode === "implementation" && !isImplementation(edge.kind)) return false;
			if (
				mode !== "implementation" &&
				(isImplementation(edge.kind) || isImplementation(nodes.get(edge.from)?.kind) || isImplementation(nodes.get(edge.to)?.kind))
			)
				return false;
			if (text && !edge.label.toLowerCase().includes(text) && !named(edge.from).includes(text) && !named(edge.to).includes(text)) return false;
			return !focus || edge.from === focus || edge.to === focus;
		})
		.map(edge => ({ ...edge, group: mode === "implementation" ? "implementation" : edgeGroup(edge, nodes) }));
	const tally = { groups: Object.fromEntries(EDGE_GROUPS.map(g => [g.id, 0])), issues: 0, total: scoped.length };
	for (const edge of scoped) {
		if (edge.group in tally.groups) tally.groups[edge.group]++;
		if (isOpenIssue(edge)) tally.issues++;
	}
	const edges = scoped.filter(edge => {
		if (hide.includes(edge.group)) return false;
		if (mode === "integrations" && (edge.kind !== "role" || nodes.get(edge.from)?.kind === "authority")) return false;
		if (mode === "roles" && !["role", "roleAdmin", "ownership"].includes(edge.kind)) return false;
		if (mode === "wiring" && ["role", "roleAdmin", "ownership"].includes(edge.kind)) return false;
		return !missingOnly || isOpenIssue(edge);
	});
	for (const edge of edges)
		for (const key of ["from", "to"]) {
			if (!nodes.has(edge[key])) {
				const address = edge[key].startsWith("address:") ? edge[key].slice(8) : edge.actual;
				nodes.set(edge[key], {
					id: edge[key],
					name: "Referenced address",
					address,
					kind: "external",
					status: "observed",
					state: {},
					errors: [],
				});
			}
		}
	const connected = new Set(edges.flatMap(e => [e.from, e.to]));
	// Hiding a group of connections keeps every contract in place, so the map does not reshuffle under the cursor.
	if (mode === "all" && !focus && !missingOnly && !text) for (const n of nodes.values()) if (!isImplementation(n.kind)) connected.add(n.id);
	if (focus && nodes.has(focus) && (mode === "implementation" || !isImplementation(nodes.get(focus).kind))) connected.add(focus);
	// A search finds a contract by name, alias or address even when none of its connections match, so a listed
	// address that holds nothing can still be found. One contract's neighbourhood keeps to its neighbours.
	if (text && !focus)
		for (const n of snapshot.nodes)
			if ((mode === "implementation" || !isImplementation(n.kind)) && named(n.id).includes(text)) connected.add(n.id);
	return {
		nodes: [...nodes.values()].filter(n => connected.has(n.id)),
		edges,
		tally,
		unconnected: snapshot.nodes.filter(n => !connected.has(n.id) && (mode === "implementation" || !isImplementation(n.kind))),
	};
}

// The canvas draws one link per ordered contract pair. Every grant stays on the link,
// so nothing is merged away: the link carries the count and the worst state.
export const linkId = (from, to) => `${from}>${to}`;
export function bundleEdges(edges) {
	const links = new Map();
	for (const edge of edges) {
		const id = linkId(edge.from, edge.to);
		if (!links.has(id)) links.set(id, { id, from: edge.from, to: edge.to, edges: [] });
		links.get(id).edges.push(edge.state ? edge : { ...edge, state: edgeStatus(edge) });
	}
	return [...links.values()].map(link => {
		const missing = link.edges.filter(e => e.state === "missing").length,
			unknown = link.edges.filter(e => e.state === "unknown" && !e.removed).length,
			count = link.edges.length,
			gone = link.edges.filter(e => e.removed).length,
			fresh = link.edges.filter(e => e.diff === "added").length,
			altered = link.edges.filter(e => e.diff === "changed").length;
		return {
			...link,
			// Problems sort first so the reason a link is red is the first row read.
			edges: [...link.edges].sort((a, b) => (a.state === "set") - (b.state === "set")),
			count,
			missing,
			unknown,
			state: missing ? "missing" : unknown ? "unknown" : "set",
			label: count === 1 ? link.edges[0].label : `${count} connections${missing ? ` · ${missing} missing` : ""}`,
			// Only present when the snapshot was marked with its changes since the previous inspection.
			...(gone || fresh || altered ? { diff: gone === count ? "removed" : fresh === count ? "added" : "changed" } : {}),
		};
	});
}

// Fixed semantic lanes keep direction meaningful even when roles form cycles.
export const SYSTEM_LANES = [
	{ name: "Governance", kinds: ["authority", "safe", "timelock", "proxyAdmin"] },
	{ name: "Execution", kinds: ["gasless", "partyB", "instantLayer"] },
	{ name: "Core & accounts", kinds: ["core", "accountLayer", "multiAccount"] },
	{ name: "Services", kinds: ["express", "verifier", "symbolManager", "liquidator", "feeDistributor", "token"] },
	{ name: "Affiliates & external", kinds: ["affiliate", "external"] },
];
const IMPLEMENTATION_LANES = [
	{ name: "Contracts", kinds: [] },
	{ name: "Facets & implementations", kinds: ["facet", "implementation"] },
	{ name: "Libraries", kinds: ["library"] },
];
export const LAYOUT = { column: 236, row: 88, gap: 150, rows: 8, compactRows: 6 };
// `compact` suits one contract's neighborhood: the lanes either side of Core share a
// column group, so a handful of contracts is not spread thin across five lanes.
export function semanticLayout(nodes, { implementation = false, compact = false } = {}) {
	const lanes = implementation ? IMPLEMENTATION_LANES : SYSTEM_LANES;
	const laneOf = node => {
		const index = lanes.findIndex(lane => lane.kinds.includes(node.kind));
		return index < 0 ? (implementation ? 0 : lanes.length - 1) : index;
	};
	const rank = node => {
		const i = lanes[laneOf(node)].kinds.indexOf(node.kind);
		return i < 0 ? 999 : i;
	};
	const center = lanes.findIndex(lane => lane.kinds.includes("core"));
	const merge = compact && !implementation && center > 0;
	const groupOf = index => (merge ? Math.sign(index - center) + 1 : index);
	const groups = Array.from({ length: merge ? 3 : lanes.length }, () => []);
	for (const node of nodes) groups[groupOf(laneOf(node))].push(node);
	const positions = {},
		sections = [];
	let x = 0;
	for (const group of groups) {
		if (!group.length) continue;
		group.sort((a, b) => laneOf(a) - laneOf(b) || rank(a) - rank(b) || `${a.name}:${a.id}`.localeCompare(`${b.name}:${b.id}`));
		// Compact grids prevent large authority inventories becoming a long column.
		const columns = Math.ceil(group.length / (merge ? LAYOUT.compactRows : LAYOUT.rows)),
			rows = Math.ceil(group.length / columns);
		const width = columns * LAYOUT.column;
		// A sparse centre column gets room for the links that run between its own contracts.
		const pitch = merge && group === groups[1] && group.length <= 3 ? LAYOUT.row * 2 : LAYOUT.row;
		// Column-major order keeps each lane's contracts together inside a merged group.
		for (const [i, node] of group.entries())
			positions[node.id] = {
				x: x + Math.floor(i / rows) * LAYOUT.column + LAYOUT.column / 2,
				y: ((i % rows) - (rows - 1) / 2) * pitch,
			};
		const names = [...new Set(group.map(node => lanes[laneOf(node)].name))];
		sections.push({ name: names.join(" · "), x: x + width / 2, width, count: group.length, rows });
		x += width + LAYOUT.gap;
	}
	return { positions, sections };
}
