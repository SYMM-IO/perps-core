import { discoverRoleHistoryFromSubgraph } from "../server/discovery.js";
import { assertSubgraphUrl, readRoleEvents, subgraphClient, subgraphName } from "../server/sources/subgraph.js";
import { id } from "ethers";
import assert from "node:assert/strict";
import test from "node:test";

const URL_EVENTS = "https://api.example-indexer.com/api/public/project_x/subgraphs/arbitrum-vibe-mainnet-events/stage/gn";
const address = index => `0x${index.toString(16).padStart(40, "0")}`;
const SETTER = id("SETTER_ROLE"),
	PAUSER = id("PAUSER_ROLE");
const row = (n, source, role, holder, block, logIndex = 0, field = "user") => ({
	id: `0x${String(n).padStart(4, "0")}`,
	source,
	role,
	[field]: holder,
	sender: address(99),
	blockNumber: String(block),
	blockTimestamp: String(1_700_000_000 + block),
	transactionHash: `0x${String(n).padStart(64, "0")}`,
	logIndex: String(logIndex),
});
/** A stand-in indexer: answers `_meta` and pages through its collections by the id cursor. */
function indexer({ collections = {}, meta = { block: 500, hasIndexingErrors: false }, calls = [] } = {}) {
	return async (url, init) => {
		const { query } = JSON.parse(init.body);
		calls.push({ url, query, method: init.method, redirect: init.redirect });
		if (query.includes("_meta"))
			return new Response(
				JSON.stringify({
					data: { _meta: { block: { number: meta.block, timestamp: 1 }, deployment: "Qm1", hasIndexingErrors: meta.hasIndexingErrors } },
				}),
			);
		const name = query.match(/\{ (\w+)\(/)[1],
			last = query.match(/id_gt: "([^"]*)"/)[1],
			size = Number(query.match(/first: (\d+)/)[1]);
		if (!(name in collections)) return new Response(JSON.stringify({ errors: [{ message: `Type \`Query\` has no field \`${name}\`` }] }));
		const rows = collections[name].filter(r => r.id > last).sort((a, b) => a.id.localeCompare(b.id));
		return new Response(JSON.stringify({ data: { [name]: rows.slice(0, size) } }));
	};
}

test("only a public https subgraph endpoint is ever contacted", () => {
	assert.equal(assertSubgraphUrl(URL_EVENTS), URL_EVENTS);
	assert.equal(subgraphName(URL_EVENTS), "arbitrum-vibe-mainnet-events/stage");
	assert.equal(subgraphName("https://graph.example.io/subgraphs/name/coti-perps-analytics"), "coti-perps-analytics");
	for (const bad of [
		"http://api.example.com/subgraphs/x",
		"https://127.0.0.1/subgraphs/x",
		"https://[::1]/subgraphs/x",
		"https://localhost/subgraphs/x",
		"https://10.0.0.8/subgraphs/x",
		"https://169.254.169.254/latest/meta-data",
		"https://metadata.internal/x",
		"https://intranet/x",
		"https://user:pass@api.example.com/x",
		"file:///etc/passwd",
		"not a url",
	])
		assert.throws(() => assertSubgraphUrl(bad), /Subgraph endpoint/, bad);
});

test("the client pages through a whole collection, pins the block, and reports indexer failures plainly", async () => {
	const calls = [];
	const many = Array.from({ length: 2300 }, (_, i) => row(i, address(1), SETTER, address(1000 + i), i));
	const client = subgraphClient(URL_EVENTS, { fetchImpl: indexer({ collections: { roleGranteds: many }, calls }) });
	assert.deepEqual(await client.meta(), { block: 500, timestamp: 1, deployment: "Qm1", hasIndexingErrors: false });
	const rows = await client.all("roleGranteds", "role user", { block: 480 });
	assert.equal(rows.length, 2300);
	assert.equal(new Set(rows.map(r => r.id)).size, 2300);
	const pages = calls.filter(c => c.query.includes("roleGranteds"));
	assert.equal(pages.length, 3);
	assert.ok(pages.every(c => c.query.includes("block: { number: 480 }") && c.method === "POST" && c.redirect === "error" && c.url === URL_EVENTS));
	await assert.rejects(client.all("roleGranteds { id } evil: users", "id"), /Invalid subgraph selection/);
	await assert.rejects(client.all("missing", "id"), /Subgraph rejected the query/);
	await assert.rejects(subgraphClient(URL_EVENTS, { fetchImpl: async () => new Response("down", { status: 502 }) }).meta(), /HTTP 502/);
	await assert.rejects(subgraphClient(URL_EVENTS, { fetchImpl: async () => new Response("<html>") }).meta(), /not JSON/);
	await assert.rejects(
		subgraphClient(URL_EVENTS, {
			fetchImpl: async () => {
				throw new Error("getaddrinfo ENOTFOUND");
			},
		}).meta(),
		/did not answer/,
	);
});

test("role events replay to who holds what now, across both event shapes", async () => {
	const core = address(1),
		verifier = address(2);
	const client = subgraphClient(URL_EVENTS, {
		fetchImpl: indexer({
			collections: {
				roleGranteds: [
					row(1, core, SETTER, address(10), 100),
					row(2, core, PAUSER, address(10), 100, 1),
					row(3, core, SETTER, address(11), 110),
					// Granted, revoked, then granted again: the last event wins.
					row(4, core, PAUSER, address(12), 120),
					row(6, core, PAUSER, address(12), 140),
					// OpenZeppelin names the holder `account` and leaves `user` empty.
					{ ...row(7, verifier, SETTER, null, 150), account: address(13) },
					{ ...row(8, core, "0x1234", address(14), 160) },
					{ ...row(9, core, SETTER, null, 170) },
				],
				roleRevokeds: [row(5, core, PAUSER, address(12), 130), row(10, core, SETTER, address(11), 180)],
			},
		}),
	});
	const events = await readRoleEvents(client, { block: 500 });
	assert.deepEqual(
		{ grants: events.grants, revocations: events.revocations, unreadable: events.unreadable },
		{ grants: 6, revocations: 2, unreadable: 2 },
	);
	assert.deepEqual(
		events.current.map(e => [e.contract.slice(-1), e.role === SETTER ? "SETTER" : "PAUSER", parseInt(e.holder.slice(-2), 16), e.block]).sort(),
		[
			["1", "PAUSER", 10, 100],
			["1", "PAUSER", 12, 140],
			["1", "SETTER", 10, 100],
			["2", "SETTER", 13, 150],
		],
	);
	assert.equal(events.everHeld.length, 5);
	assert.match(events.current[0].tx, /^0x0+\d$/);
});

test("subgraph discovery adds holders and unknown roles for the chain to confirm, and says what it could not place", async () => {
	const nodes = [
		{ id: "core", kind: "core", name: "Symmio", address: address(1), status: "observed", state: {}, errors: [] },
		{ id: "gov", kind: "authority", name: "Admin", address: address(10), status: "observed", state: {}, errors: [] },
		{ id: "gone", kind: "external", name: "No code", address: address(3), status: "no-code", state: {}, errors: [] },
	];
	const progress = [];
	const history = await discoverRoleHistoryFromSubgraph({
		nodes,
		links: [
			{ label: "Analytics", url: "https://api.example-indexer.com/subgraphs/analytics/latest/gn" },
			{ label: "Events", url: URL_EVENTS },
		],
		blockNumber: 480,
		onProgress: m => progress.push(m),
		client: url =>
			subgraphClient(url, {
				fetchImpl: indexer({
					meta: { block: 500, hasIndexingErrors: false },
					collections: {
						roleGranteds: [
							row(1, address(1), SETTER, address(10), 100),
							row(2, address(1), PAUSER, address(20), 110),
							row(3, address(1), PAUSER, address(21), 120),
							row(5, address(77), SETTER, address(22), 130),
							row(6, address(3), SETTER, address(23), 140),
						],
						roleRevokeds: [row(4, address(1), PAUSER, address(21), 125)],
					},
				}),
			}),
	});
	assert.deepEqual(
		{ ...history, contractsOutsideInventory: history.contractsOutsideInventory.map(a => a.toLowerCase()) },
		{
			source: "subgraph",
			complete: true,
			subgraph: {
				label: "Events",
				name: "arbitrum-vibe-mainnet-events/stage",
				block: 500,
				behind: 0,
				deployment: "Qm1",
				hasIndexingErrors: false,
			},
			eventCount: 6,
			grants: 5,
			revocations: 1,
			unreadable: 0,
			holdersToConfirm: 2,
			// A contract the inventory does not know, and one with no code, are reported instead of guessed at.
			contractsOutsideInventory: [address(77), address(3)],
			requests: 0,
			unreadRanges: 0,
			fromBlock: 0,
			toBlock: 480,
		},
	);
	assert.deepEqual(
		nodes[0].roleHistory.map(r => [r.hash === SETTER ? "SETTER" : "PAUSER", parseInt(r.holder.slice(-2), 16), r.block, r.admin]),
		[
			["SETTER", 10, 100, false],
			["PAUSER", 20, 110, false],
		],
	);
	assert.equal(nodes.find(n => n.address === address(20))?.name, "Role holder");
	assert.equal(
		nodes.some(n => n.address === address(21)),
		false,
		"a revoked holder is not added",
	);
	assert.equal(nodes.filter(n => n.address === address(10)).length, 1, "a holder already in the inventory is not duplicated");
	assert.match(progress[0], /arbitrum-vibe-mainnet-events/);

	assert.equal(await discoverRoleHistoryFromSubgraph({ nodes, links: [{ label: "Analytics", url: URL_EVENTS }], blockNumber: 1 }), null);
	const stalled = await discoverRoleHistoryFromSubgraph({
		nodes: [nodes[0]],
		links: [{ label: "Events", url: URL_EVENTS }],
		blockNumber: 900,
		client: url =>
			subgraphClient(url, {
				fetchImpl: indexer({ meta: { block: 500, hasIndexingErrors: true }, collections: { roleGranteds: [], roleRevokeds: [] } }),
			}),
	});
	assert.deepEqual([stalled.complete, stalled.subgraph.behind, stalled.toBlock], [false, 400, 500]);
});
