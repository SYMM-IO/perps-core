import { edgeKind, linkId } from "./graph-model.js";

// Addresses that are only ever holders or targets. Protocol contracts are never stacked: each one is its own thing.
const STACKABLE = new Set(["authority", "external"]);
const digest = text => {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	return (hash >>> 0).toString(36);
};

/**
 * Draws addresses that are wired identically as one node. Nine wallets that each hold the same role on
 * the same contract say one thing nine times; as one stack they say it once and leave room for the rest.
 * Nothing is merged away: every connection stays on its link and remembers which address it belongs to.
 *
 * @param {{ nodes: any[], edges: any[] }} model a graph model, after filters
 * @param {{ keep?: string[], expanded?: string[] }} [options] addresses to leave alone, and stacks opened by hand
 */
export function stackModel(model, { keep = [], expanded = [] } = {}) {
	const alone = new Set(keep),
		open = new Set(expanded),
		wiring = new Map(model.nodes.map(n => [n.id, []]));
	// Two addresses at different places in the same list (`getAllDistributors[0]`, `[3]`) are wired alike.
	const line = (direction, other, e) => `${direction}|${other}|${e.kind}|${e.label.replace(/\[\d+\]/g, "[]")}|${e.state}|${e.diff || ""}`;
	for (const e of model.edges) {
		wiring.get(e.from)?.push(line(">", e.to, e));
		wiring.get(e.to)?.push(line("<", e.from, e));
	}
	const alike = new Map();
	for (const n of model.nodes) {
		const own = wiring.get(n.id);
		if (!STACKABLE.has(n.kind) || alone.has(n.id) || n.removed) continue;
		// Addresses with no connections have only their name in common: listed operators that hold nothing stack
		// with others listed under the same name, and never with anything else.
		// A new address never stacks with one that was already there.
		const key = `${n.kind}|${n.diff || ""}\n${own.length ? [...own].sort().join("\n") : `-\n${n.name}`}`;
		alike.set(key, [...(alike.get(key) || []), n]);
	}
	const memberOf = new Map(),
		stacks = new Map();
	for (const members of alike.values()) {
		if (members.length < 2) continue;
		const id = `stack:${digest(
			members
				.map(m => m.id)
				.sort()
				.join(),
		)}`;
		if (open.has(id)) continue;
		const names = new Set(members.map(m => m.name)),
			own = wiring.get(members[0].id);
		stacks.set(id, {
			id,
			kind: members[0].kind,
			name:
				names.size === 1
					? `${members.length} × ${members[0].name}`
					: `${members.length} ${members[0].kind === "authority" ? "wallets" : "addresses"}`,
			// The name without the count, for where the count is shown some other way.
			title: names.size === 1 ? members[0].name : members[0].kind === "authority" ? "Wallets" : "Addresses",
			address: "",
			stack: true,
			...(members[0].diff ? { diff: members[0].diff } : {}),
			members,
			// What each member has: named when it is one thing, counted when it is several.
			summary: !own.length ? "no connections" : own.length === 1 ? own[0].split("|")[3] : `${own.length} connections each`,
			status: "observed",
			state: {},
			errors: [],
		});
		for (const m of members) memberOf.set(m.id, id);
	}
	if (!stacks.size) return { ...model, stacks, memberOf };
	const placed = new Set();
	return {
		...model,
		// A stack takes the place of its first member, so the rest of the map keeps its order.
		nodes: model.nodes.flatMap(n => {
			const id = memberOf.get(n.id);
			if (!id) return [n];
			if (placed.has(id)) return [];
			placed.add(id);
			return [stacks.get(id)];
		}),
		edges: model.edges.map(e =>
			memberOf.has(e.from) || memberOf.has(e.to)
				? {
						...e,
						from: memberOf.get(e.from) ?? e.from,
						to: memberOf.get(e.to) ?? e.to,
						...(memberOf.has(e.from) ? { fromMember: e.from } : {}),
						...(memberOf.has(e.to) ? { toMember: e.to } : {}),
					}
				: e,
		),
		stacks,
		memberOf,
	};
}

// Whoever controls one of these acts with its authority, so a question about power continues through it.
const ACTS_FOR_ITS_OWNERS = new Set(["safe", "timelock", "proxyAdmin"]);
/** What a verified connection lets its holder do to the contract it points at, if anything. */
const powerOf = edge => {
	if (edge.status !== "verified") return null;
	const kind = edgeKind(edge);
	return kind === "role" ? "holds" : kind === "roleAdmin" ? "grants" : kind === "ownership" ? "owns" : null;
};
/**
 * Answers the two questions a role list cannot: what can this address change, and who can change this
 * contract. Three things count as power, and only when the chain confirmed them: holding a role, being
 * the admin of a role (which can hand that role to anyone, itself included), and owning a contract. The
 * walk continues through Safes, timelocks and proxy admins, because their owners act through them.
 *
 * @param {{ nodes: any[], edges: any[] }} snapshot
 * @param {string} root
 * @param {"over" | "under"} direction "over": what `root` can change. "under": who can change `root`.
 */
export function power(snapshot, root, direction = "over") {
	const kindOf = new Map(snapshot.nodes.map(n => [n.id, n.kind])),
		grants = snapshot.edges.map(edge => ({ edge, how: powerOf(edge) })).filter(g => g.how),
		found = new Map(),
		seen = new Set([root]),
		queue = [{ id: root, via: [] }];
	while (queue.length) {
		const { id, via } = queue.shift();
		for (const { edge, how } of grants) {
			const [near, far] = direction === "over" ? [edge.from, edge.to] : [edge.to, edge.from];
			if (near !== id || far === root) continue;
			const key = `${far}|${via.join(">")}`;
			if (!found.has(key)) found.set(key, { node: far, via, holds: [], grants: [], owns: [], link: linkId(edge.from, edge.to) });
			found.get(key)[how].push(edge.label.replace(/^Admin · /, ""));
			if (ACTS_FOR_ITS_OWNERS.has(kindOf.get(far)) && !seen.has(far)) {
				seen.add(far);
				queue.push({ id: far, via: [...via, far] });
			}
		}
	}
	const weight = e => e.owns.length * 1000 + e.grants.length * 10 + e.holds.length;
	const entries = [...found.values()].sort((a, b) => a.via.length - b.via.length || weight(b) - weight(a) || a.node.localeCompare(b.node));
	return {
		root,
		direction,
		entries,
		nodes: new Set([root, ...entries.flatMap(e => [e.node, ...e.via])]),
		links: new Set(entries.map(e => e.link)),
	};
}

const connectionKey = (from, to, kind, label) => [from, to, kind, label].join(":");
/**
 * Turns the list of differences between two inspections into something the map can draw: which
 * contracts are new or altered, which connections appeared or changed, and what is gone. Counters and
 * other state that changes on every block are left to the Changes tab; the map shows wiring.
 *
 * @param {{ nodes: any[], edges: any[] }} snapshot
 * @param {any[]} [delta]
 */
export function changeOverlay(snapshot, delta = []) {
	const present = new Set(snapshot.nodes.map(n => n.id)),
		nodes = new Map(),
		ghosts = [],
		edges = new Map(),
		removed = [];
	for (const d of delta) {
		if (d.kind === "contract") {
			// A contract appearing or going is one thing; a new implementation behind the same contract is a change to it.
			if (d.field !== "contract") nodes.has(d.node) || nodes.set(d.node, "changed");
			else if (d.before === null) nodes.set(d.node, "added");
			else if (!present.has(d.node))
				ghosts.push({
					id: d.node,
					name: d.name || d.node,
					kind: d.nodeKind || "external",
					address: d.before,
					removed: true,
					status: "removed",
					state: {},
					errors: [],
				});
		} else if (d.kind === "connection") {
			if (d.after === null)
				removed.push({
					from: d.node,
					to: d.to,
					label: d.label,
					kind: d.edgeKind,
					status: "removed",
					actual: d.before?.value,
					removed: true,
					diff: "removed",
				});
			else edges.set(connectionKey(d.node, d.to, d.edgeKind, d.label), d.before === null ? "added" : "changed");
		}
	}
	return { nodes, ghosts, edges, removed, count: nodes.size + ghosts.length + edges.size + removed.length };
}
/** The snapshot with its changes marked, and with what has gone put back so it can be drawn as gone. */
export function withChanges(snapshot, overlay) {
	return {
		...snapshot,
		nodes: [...snapshot.nodes.map(n => (overlay.nodes.has(n.id) ? { ...n, diff: overlay.nodes.get(n.id) } : n)), ...overlay.ghosts],
		edges: [
			...snapshot.edges.map(e => {
				const diff = overlay.edges.get(connectionKey(e.from, e.to, e.kind, e.label));
				return diff ? { ...e, diff } : e;
			}),
			...overlay.removed,
		],
	};
}
