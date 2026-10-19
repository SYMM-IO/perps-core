import { changeOverlay, power, powerOf, stackModel, withChanges } from "./graph-insight.js";
import { bundleEdges, graphModel, LAYOUT, linkId, semanticLayout } from "./graph-model.js";

// The derived view the wiring map draws, step by step. Each step is pure, so the map can keep each one
// until its own inputs change and the whole chain can be tested without a browser.

const NONE = new Map();
/** A model's stacks and their members, which a model without stacks does not carry. */
export const stacksOf = model => ({ stacks: model.stacks ?? NONE, memberOf: model.memberOf ?? NONE });

/** What the map is drawn around. When this changes the map is fitted again; otherwise the view holds still. */
export const scopeKey = ({ mode = "all", focus = "", query = "", missingOnly = false } = {}) =>
	[mode, focus, query.trim().toLowerCase(), missingOnly ? 1 : 0].join("|");

/** The snapshot as drawn: with what changed since the previous inspection marked, when that is asked for. */
export function changeView(snapshot, delta = [], changes = false) {
	const overlay = changeOverlay(snapshot, delta),
		showChanges = changes && overlay.count > 0;
	return { overlay, showChanges, drawn: showChanges ? withChanges(snapshot, overlay) : snapshot };
}

/**
 * The connections the filters leave, with the answer to an open question added. A question about power
 * is answered in full in the panel, so the map draws every line of the answer whatever the filters say,
 * and `answer.outside` counts the connections that are drawn only because of it.
 *
 * @param {{ nodes: any[], edges: any[] }} drawn
 * @param {{ mode?: string, focus?: string, missingOnly?: boolean, query?: string, hide?: string[] }} filters
 * @param {{ links: Set<string> } | null} [reached] what `power()` answered
 */
export function filterView(drawn, filters, reached = null) {
	const implementation = filters.mode === "implementation",
		plain = graphModel(drawn, filters),
		every = graphModel(drawn, { mode: implementation ? "implementation" : "all" });
	// A question is asked of the whole system; one contract's neighbourhood keeps to that contract.
	const answer = reached && !implementation && !filters.focus ? every.edges.filter(e => reached.links.has(linkId(e.from, e.to)) && powerOf(e)) : [];
	const shown = new Set(plain.edges.map(e => e.id)),
		outside = answer.filter(e => !shown.has(e.id)),
		counts = { total: answer.length, outside: outside.length };
	if (!outside.length) return { plain, every, base: plain, answer: counts };
	const have = new Set(plain.nodes.map(n => n.id)),
		known = new Map(every.nodes.map(n => [n.id, n])),
		extra = [...new Set(outside.flatMap(e => [e.from, e.to]))].filter(id => !have.has(id) && known.has(id)).map(id => known.get(id));
	return { plain, every, base: { ...plain, nodes: [...plain.nodes, ...extra], edges: [...plain.edges, ...outside] }, answer: counts };
}

/**
 * What is drawn, once stacked: the lines, what a question or the change view lights, the lanes, and the
 * numbers the map reports about itself.
 *
 * @param {{ nodes: any[], edges: any[], stacks?: Map<string, any>, memberOf?: Map<string, string> }} model
 * @param {{ plain: { tally: { total: number } }, reached?: { nodes: Set<string>, links: Set<string> } | null, showChanges?: boolean, filters?: { mode?: string, focus?: string } }} options
 */
export function finishView(model, { plain, reached = null, showChanges = false, filters = {} }) {
	const { stacks, memberOf } = stacksOf(model),
		links = bundleEdges(model.edges);
	const at = id => memberOf.get(id) ?? id;
	let lit = null;
	if (reached)
		lit = {
			nodes: new Set([...reached.nodes].map(at)),
			links: new Set([...reached.links].map(id => id.split(">").map(at).join(">"))),
		};
	else if (showChanges) {
		const marked = links.filter(l => l.diff);
		lit = {
			nodes: new Set([...model.nodes.filter(n => n.diff || n.removed).map(n => n.id), ...marked.flatMap(l => [l.from, l.to])]),
			links: new Set(marked.map(l => l.id)),
		};
	}
	const layout = semanticLayout(model.nodes, { implementation: filters.mode === "implementation", compact: !!filters.focus });
	// Lane names sit above the tallest lane, clear of its first row.
	const top = Math.min(0, ...Object.values(layout.positions).map(p => p.y)) - LAYOUT.row / 2 - 11;
	const positions = { ...layout.positions, ...Object.fromEntries(layout.sections.map(s => [`lane:${s.name}`, { x: s.x, y: top }])) };
	const tally = {
		addresses: model.nodes.reduce((sum, n) => sum + (n.stack ? n.members.length : 1), 0),
		nodes: model.nodes.length,
		stacks: stacks.size,
		connections: links.reduce((sum, l) => sum + l.count, 0),
		of: plain.tally.total,
		issues: links.reduce((sum, l) => sum + l.missing, 0),
	};
	return { links, lit, layout, positions, tally };
}

/**
 * The whole chain in one call: change marks, filters, the question's answer, stacks, lines, lighting,
 * layout and tallies. The map runs the same steps one at a time so each is kept until its inputs change.
 */
export function mapView({ snapshot, delta = [], filters = {}, selected = "", reach = null, stacking = true, expanded = [], changes = false }) {
	const { overlay, showChanges, drawn } = changeView(snapshot, delta, changes),
		reached = reach ? power(snapshot, reach.id, reach.direction) : null,
		{ plain, every, base, answer } = filterView(drawn, filters, reached);
	// Whatever is being looked at stays its own node, never folded into a stack.
	const keep = [selected, filters.focus, reach?.id].filter(Boolean),
		model = stacking ? stackModel(base, { keep, expanded }) : base;
	return {
		overlay,
		showChanges,
		drawn,
		reached,
		plain,
		every,
		base,
		answer,
		model,
		...stacksOf(model),
		stackCount: stacksOf(stackModel(base, { keep })).stacks.size,
		...finishView(model, { plain, reached, showChanges, filters }),
	};
}

/**
 * Contracts a search names, best first: an exact name, alias or address, then names that start with the
 * text, then names that contain it, then addresses and ids that contain it.
 */
export function findContracts(nodes, query) {
	const text = query.trim().toLowerCase();
	if (!text) return [];
	const rank = n => {
		const name = (n.name || "").toLowerCase(),
			address = (n.address || "").toLowerCase(),
			aliases = (n.aliases || []).map(a => a.toLowerCase());
		if (name === text || address === text || aliases.includes(text) || n.id === text) return 0;
		if (name.startsWith(text) || aliases.some(a => a.startsWith(text)) || (text.startsWith("0x") && address.startsWith(text))) return 1;
		if (name.includes(text) || aliases.some(a => a.includes(text))) return 2;
		return address.includes(text) || n.id.toLowerCase().includes(text) ? 3 : -1;
	};
	const seen = new Set();
	return nodes
		.filter(n => !seen.has(n.id) && seen.add(n.id))
		.map(n => [n, rank(n)])
		.filter(([, r]) => r >= 0)
		.sort((a, b) => a[1] - b[1] || (a[0].name || "").localeCompare(b[0].name || ""))
		.map(([n]) => n);
}
/** Text that can only be (part of) an address. */
export const looksLikeAddress = query => /^0x[0-9a-f]{4,40}$/i.test(query.trim());

// Two contracts closer than this on both axes overlap. A lane's grid is exactly one column and one row apart.
const SPACE = { width: LAYOUT.column - 12, height: LAYOUT.row - 16 };
// Places beside a spot, nearest first: up and down its own column before the columns either side.
const AROUND = Array.from({ length: 7 }, (_, i) => i - 3)
	.flatMap(i => Array.from({ length: 25 }, (_, j) => [i, j - 12]))
	.filter(([i, j]) => i || j)
	.sort(([ai, aj], [bi, bj]) => Math.abs(ai) * 3 + Math.abs(aj) - (Math.abs(bi) * 3 + Math.abs(bj)) || bj - aj || bi - ai);

/**
 * Where each contract goes when the drawing changes but its scope does not. A contract already on the map
 * stays where it is, including where it was dragged. A stack goes where most of its members were. An
 * address that leaves a stack takes the stack's place, or the nearest free place beside it, so the lane
 * around it is not laid out again. Anything else goes where a fresh layout would put it, or beside that.
 *
 * @param {any[]} nodes the nodes to draw
 * @param {Record<string, {x: number, y: number}>} fresh where a fresh layout puts each one
 * @param {{ positions: Record<string, {x: number, y: number}>, memberOf?: Map<string, string>, reserved?: {x: number, y: number}[] } | null} previous
 *   what was drawn before: positions by id, which stack each address was in, and places to keep clear (lane names)
 */
export function placeNodes(nodes, fresh, previous) {
	if (!previous) return Object.fromEntries(nodes.map(n => [n.id, { ...fresh[n.id] }]));
	const placed = {},
		taken = [...(previous.reserved || [])];
	const free = p => taken.every(q => Math.abs(q.x - p.x) >= SPACE.width || Math.abs(q.y - p.y) >= SPACE.height);
	const beside = p => {
		for (const [i, j] of AROUND) {
			const spot = { x: p.x + i * LAYOUT.column, y: p.y + j * LAYOUT.row };
			if (free(spot)) return spot;
		}
		return { x: p.x, y: p.y + 13 * LAYOUT.row };
	};
	const claim = (id, p) => {
		placed[id] = free(p) ? { ...p } : beside(p);
		taken.push(placed[id]);
	};
	const was = id => previous.positions[id] ?? previous.positions[previous.memberOf?.get(id)];
	for (const n of nodes)
		if (previous.positions[n.id]) {
			placed[n.id] = { ...previous.positions[n.id] };
			taken.push(placed[n.id]);
		}
	for (const n of nodes) {
		if (placed[n.id] || !n.stack) continue;
		const spots = new Map();
		for (const m of n.members) {
			const p = was(m.id);
			if (p) spots.set(`${p.x},${p.y}`, { p, count: (spots.get(`${p.x},${p.y}`)?.count || 0) + 1 });
		}
		const best = [...spots.values()].sort((a, b) => b.count - a.count)[0];
		if (best) claim(n.id, best.p);
	}
	for (const n of nodes) if (!placed[n.id] && was(n.id)) claim(n.id, was(n.id));
	for (const n of nodes) if (!placed[n.id]) claim(n.id, fresh[n.id] || { x: 0, y: 0 });
	return placed;
}
