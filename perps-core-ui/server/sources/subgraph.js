import { getAddress } from "ethers";
import { isIP } from "node:net";

const PAGE = 1000;
const MAX_ROWS = 50_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** The last path segments that name a hosted subgraph, without the account it belongs to. */
export function subgraphName(url) {
	const parts = new URL(url).pathname.split("/").filter(Boolean);
	const at = parts.indexOf("subgraphs");
	return (at >= 0 ? parts.slice(at + 1) : parts.slice(-2)).filter(p => p !== "gn" && p !== "name").join("/") || new URL(url).host;
}

/**
 * A subgraph is an indexer run by someone else. Only a public https endpoint is ever contacted:
 * the address comes from a deployment profile, which an operator can import from a file.
 */
export function assertSubgraphUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Subgraph endpoint is not a URL");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("Subgraph endpoint must be a plain https URL");
	if (isIP(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes("."))
		throw new Error("Subgraph endpoint must be a public host name");
	return url.href;
}

/** A read-only GraphQL client for one subgraph. It never sends anything but the query text. */
export function subgraphClient(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
	const endpoint = assertSubgraphUrl(url);
	async function query(text) {
		let response;
		try {
			response = await fetchImpl(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ query: text }),
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new Error(`Subgraph did not answer (${error.name === "TimeoutError" ? "timed out" : error.message})`);
		}
		if (!response.ok) throw new Error(`Subgraph answered HTTP ${response.status}`);
		const body = await response.text();
		if (body.length > MAX_BYTES) throw new Error("Subgraph answer is too large");
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error("Subgraph answer is not JSON");
		}
		if (parsed.errors?.length) throw new Error(`Subgraph rejected the query: ${String(parsed.errors[0].message).slice(0, 200)}`);
		if (!parsed.data) throw new Error("Subgraph answer has no data");
		return parsed.data;
	}
	return {
		url: endpoint,
		name: subgraphName(endpoint),
		query,
		/** How far the indexer has read, and whether it has stopped on an error. */
		async meta() {
			const { _meta } = await query("{ _meta { block { number timestamp } deployment hasIndexingErrors } }");
			return {
				block: Number(_meta.block.number),
				timestamp: Number(_meta.block.timestamp) || undefined,
				deployment: _meta.deployment,
				hasIndexingErrors: !!_meta.hasIndexingErrors,
			};
		},
		/** Every row of a collection up to `block`, read in id order so no page is skipped or repeated. */
		async all(collection, fields, { block } = {}) {
			if (!/^[A-Za-z][A-Za-z0-9]*$/.test(collection) || !/^[A-Za-z0-9 ]+$/.test(fields)) throw new Error("Invalid subgraph selection");
			const at = block === undefined ? "" : `, block: { number: ${Number(block)} }`;
			const rows = [];
			for (let last = ""; ; ) {
				const data = await query(
					`{ ${collection}(first: ${PAGE}, orderBy: id, where: { id_gt: ${JSON.stringify(last)} }${at}) { id ${fields} } }`,
				);
				const page = data[collection];
				if (!Array.isArray(page)) throw new Error(`Subgraph has no ${collection}`);
				rows.push(...page);
				if (page.length < PAGE) return rows;
				if (rows.length >= MAX_ROWS) throw new Error(`Subgraph ${collection} exceeds ${MAX_ROWS} rows`);
				last = page[page.length - 1].id;
			}
		},
	};
}

const address = value => {
	try {
		return getAddress(String(value).toLowerCase());
	} catch {
		return undefined;
	}
};
const ROLE_FIELDS = "source role user account sender blockNumber blockTimestamp transactionHash logIndex";

/**
 * Role grants and revocations as the subgraph recorded them, pinned to one indexed block so the two
 * lists describe the same moment. `current` is what should still be held if the indexer is right;
 * the caller confirms each of those on chain before showing it as a fact.
 */
export async function readRoleEvents(client, { block } = {}) {
	const normalise = (row, granted) => {
		const contract = address(row.source),
			holder = address(row.user ?? row.account);
		if (!contract || !holder || !/^0x[0-9a-f]{64}$/i.test(row.role || "")) return undefined;
		return {
			granted,
			contract,
			holder,
			role: row.role.toLowerCase(),
			sender: address(row.sender),
			block: Number(row.blockNumber),
			timestamp: Number(row.blockTimestamp) || undefined,
			tx: row.transactionHash,
			logIndex: Number(row.logIndex) || 0,
		};
	};
	const [grantRows, revokeRows] = await Promise.all([
		client.all("roleGranteds", ROLE_FIELDS, { block }),
		client.all("roleRevokeds", ROLE_FIELDS, { block }),
	]);
	const events = [...grantRows.map(r => normalise(r, true)), ...revokeRows.map(r => normalise(r, false))];
	const usable = events.filter(Boolean).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
	// Replaying in order leaves, for each contract, role and holder, the last thing that happened to it.
	const latest = new Map();
	for (const event of usable) latest.set(`${event.contract}:${event.role}:${event.holder}`, event);
	return {
		grants: usable.filter(e => e.granted).length,
		revocations: usable.filter(e => !e.granted).length,
		unreadable: events.length - usable.length,
		current: [...latest.values()].filter(e => e.granted),
		everHeld: [...latest.values()],
	};
}
