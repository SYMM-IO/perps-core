import { ADDRESSES_FILE, loadAddresses } from "../server/addresses.js";
import { id } from "ethers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const write = document => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "addresses-")), ADDRESSES_FILE);
	fs.writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
	return file;
};
const CORE = "0x57331027091994FCb9c5Aec48ea92cEf0a93CF6A",
	OPERATOR = "0x999DA1bB819b50cc85de02D088E449351FDa8B78";
const demo = (change = {}) => ({
	id: "demo",
	name: "Demo",
	chain: "testnet",
	environment: "Production",
	version: 0.8,
	subgraphs: { events: "https://api.example.com/subgraphs/events/gn" },
	contracts: { core: [{ address: CORE, aliases: ["Main"] }] },
	notes: ["left unclassified"],
	...change,
});
// Every contract a deployment of the file lists, whichever way its kind is written.
const entries = d =>
	Object.entries(d.contracts).flatMap(([kind, of]) => (typeof of === "string" ? [{ kind, address: of }] : of.map(e => ({ ...e, kind }))));
const book = (deployments = [demo()], rest = {}) => ({
	checked: "2026-10-10",
	chains: { testnet: { chainId: 42161, rpc: "https://rpc.example.com", explorer: "https://scan.example.com" } },
	roleCandidates: [{ label: "Operator", deployments: ["demo"], wallets: [OPERATOR] }],
	deployments,
	...rest,
});

test("the repository address book loads, and names the Vibe Arbitrum deployment the app opens on", () => {
	const { profiles, checked } = loadAddresses();
	assert.match(checked, /^\d{4}-\d{2}-\d{2}$/);
	const vibe = profiles.find(p => p.id === "arbitrum-vibe");
	assert.deepEqual(
		{ chainId: vibe.chainId, version: vibe.version, core: vibe.nodes.find(n => n.id === "core"), entry: vibe.source.entry },
		{
			chainId: 42161,
			version: "0.8.6.5",
			core: { id: "core", name: "Symmio", kind: "core", address: CORE },
			entry: "Vibe Arbitrum",
		},
	);
	assert.ok(vibe.links.some(l => l.label === "Events" && l.url.startsWith("https://")));
	assert.ok(vibe.roleCandidates.some(c => c.address === OPERATOR && c.name === "Gasless Layer operator"));
});

test("each thing is written once in the repository file", () => {
	const file = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../..", ADDRESSES_FILE), "utf8"));
	// A deployment says which chain it is on; the chain's id, RPC and explorer live with the chain.
	for (const d of file.deployments) {
		assert.ok(file.chains[d.chain], `${d.id}: chain ${d.chain}`);
		assert.deepEqual(
			Object.keys(d).filter(key => !["id", "name", "chain", "environment", "version", "subgraphs", "contracts", "notes"].includes(key)),
			[],
			d.id,
		);
		// Within a deployment an address is one contract.
		assert.equal(new Set(entries(d).map(c => c.address.toLowerCase())).size, entries(d).length, d.id);
		// A kind that holds one plain address is written as that address, not as a list of one.
		for (const [kind, of] of Object.entries(d.contracts))
			assert.ok(typeof of === "string" || of.length > 1 || Object.keys(of[0]).length > 1, `${d.id}: ${kind} is a list of one plain address`);
	}
	assert.equal(new Set(Object.values(file.chains).map(c => c.chainId)).size, Object.keys(file.chains).length);
	// A wallet is listed once per label, with every deployment to check it on, and never when it is already a contract there.
	const contractsOf = new Map(file.deployments.map(d => [d.id, new Set(entries(d).map(c => c.address.toLowerCase()))]));
	const seen = new Set();
	for (const group of file.roleCandidates)
		for (const wallet of group.wallets) {
			const key = `${group.label}:${wallet.toLowerCase()}`;
			assert.ok(!seen.has(key), `${wallet} is listed twice as ${group.label || "an unlabelled candidate"}`);
			seen.add(key);
			for (const id of group.deployments) assert.ok(!contractsOf.get(id).has(wallet.toLowerCase()), `${wallet} is already a contract of ${id}`);
		}
	// Role names and chain details are not copied into deployments.
	assert.doesNotMatch(JSON.stringify(file.deployments), /"observedRoles"|"roleCandidates"|"rows"|"rpc"|"chainId"/);
});

test("a contract is called the same thing in every deployment that has it", () => {
	const { profiles } = loadAddresses();
	const nameOf = new Map(),
		idOf = new Map(),
		spelling = new Map();
	for (const p of profiles)
		for (const n of p.nodes) {
			const where = `${p.id}: ${n.id} "${n.name}"`;
			assert.equal(nameOf.get(n.id) ?? n.name, n.name, `${where} has another name elsewhere`);
			assert.equal(idOf.get(n.name) ?? n.id, n.id, `${where} has another id elsewhere`);
			nameOf.set(n.id, n.name);
			idOf.set(n.name, n.id);
			// "Intentx" beside "IntentX", or "TimeLock" beside "Timelock", is one name spelled twice.
			const loose = n.name.toLowerCase().replace(/[^a-z0-9]/g, "");
			assert.equal(spelling.get(loose) ?? n.name, n.name, `${where} is also spelled "${spelling.get(loose)}"`);
			spelling.set(loose, n.name);
			// Column labels and stray punctuation are not names.
			assert.doesNotMatch(n.name, /· (Address|Addresses|Link)$|\?|^\s|\s$| {2}/, where);
			// A solver's contract is "<Solver> · PartyB", numbered from the second one on.
			assert.equal(n.kind === "partyB", /^.+ · PartyB( [2-9]\d*)?$/.test(n.name), `${where} is kind ${n.kind}`);
		}
	// Ids the app's own rules refer to keep their spelling; the rest follow the name.
	assert.deepEqual(
		["core", "collateral", "accountLayer", "instantLayer", "gasless", "express", "verifier", "symbolManager", "liquidator"].map(id =>
			nameOf.get(id),
		),
		[
			"Symmio",
			"Collateral",
			"Account Layer",
			"Instant Layer",
			"Gasless Layer",
			"Express Provider",
			"Muon Signature Verifier",
			"Symbol Manager",
			"Liquidator Proxy",
		],
	);
});

test("a contract says what it is once, and its name and id follow", () => {
	const a = n => `0x${String(n).repeat(40)}`;
	const { profiles } = loadAddresses(
		write(
			book([
				demo({
					contracts: {
						// A kind with one contract and nothing more to say is just its address.
						core: a(1),
						token: a(2),
						// A solver's contracts are numbered in the order they are written.
						partyB: [
							{ owner: "PerpsHub", address: a(3) },
							{ owner: "PerpsHub", address: a(4) },
							{ owner: "Rasa (No Hedge)", address: a(5) },
						],
						feeDistributor: [{ owner: "Vibe", address: a(6) }],
						// Where the kind does not say what the contract is, a name does, with or without an owner.
						external: [{ owner: "Vibe", name: "Hook", address: a(7), aliases: ["VibeHook"] }],
						safe: [{ name: "Main Multisig", address: a(8) }],
						// The one of its kind keeps the short id; a second has to be told apart by name.
						symbolManager: [{ address: a(9) }, { name: "Symbol Manager (new)", address: a(0) }],
					},
				}),
			]),
		),
	);
	assert.deepEqual(
		profiles[0].nodes.map(n => [n.id, n.name, n.kind]),
		[
			["core", "Symmio", "core"],
			["collateral", "Collateral", "token"],
			["perpshub-partyb", "PerpsHub · PartyB", "partyB"],
			["perpshub-partyb-2", "PerpsHub · PartyB 2", "partyB"],
			["rasa-no-hedge-partyb", "Rasa (No Hedge) · PartyB", "partyB"],
			["vibe-fee-collector", "Vibe · Fee Collector", "feeDistributor"],
			["vibe-hook", "Vibe · Hook", "external"],
			["main-multisig", "Main Multisig", "safe"],
			["symbolManager", "Symbol Manager", "symbolManager"],
			["symbol-manager-new", "Symbol Manager (new)", "symbolManager"],
		],
	);
	assert.deepEqual(profiles[0].nodes[6].aliases, ["VibeHook"]);
	// The repository file uses only this form: no contract carries an id, and none repeats its kind in a name.
	const file = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../..", ADDRESSES_FILE), "utf8"));
	for (const d of file.deployments)
		for (const c of entries(d)) {
			assert.equal(c.id, undefined, `${d.id}: ${JSON.stringify(c)}`);
			assert.doesNotMatch(
				c.name || "",
				/PartyB|MultiAccount|Affiliate$|Fee Collector|^(Symmio|Collateral|Account Layer|Instant Layer|Gasless Layer)$/,
				d.id,
			);
		}
});

test("a hand-written entry maps onto the profile the app uses, put back together from its parts", () => {
	const other = demo({ id: "other", name: "Other", subgraphs: undefined, notes: undefined });
	const { profiles } = loadAddresses(write(book([demo(), other], { olderCoreRoles: ["OLD_ROLE", `0x${"ab".repeat(32)}`] })));
	// A group needs no label: its wallets are still checked, under a plain name.
	const plain = loadAddresses(write(book([demo()], { roleCandidates: [{ deployments: ["demo"], wallets: [OPERATOR] }] })));
	assert.deepEqual(plain.profiles[0].roleCandidates, [{ address: OPERATOR, name: "Role candidate" }]);
	assert.deepEqual(profiles[0], {
		id: "demo",
		name: "Demo",
		// The chain's details come from the chain.
		chainId: 42161,
		rpc: "https://rpc.example.com",
		explorer: "https://scan.example.com",
		version: "0.8",
		environment: "Production",
		source: { entry: "Demo", checked: "2026-10-10" },
		nodes: [{ aliases: ["Main"], id: "core", name: "Symmio", kind: "core", address: CORE }],
		links: [{ label: "Events", url: "https://api.example.com/subgraphs/events/gn" }],
		notes: ["left unclassified"],
		// The wallet is listed once, and reaches each deployment its group names.
		roleCandidates: [{ address: OPERATOR, name: "Operator" }],
		// A role name becomes its hash; a bare hash stays a role nobody has a name for.
		observedRoles: [
			{ contract: "core", name: "OLD_ROLE", hash: id("OLD_ROLE") },
			{ contract: "core", name: "UNKNOWN_ROLE", hash: `0x${"ab".repeat(32)}` },
		],
	});
	// A deployment the group does not name gets none of its wallets, and what it leaves out comes back empty.
	assert.deepEqual([profiles[1].roleCandidates, profiles[1].links, profiles[1].notes], [[], [], []]);
});

test("the mistakes that are easy to make by hand are refused by name", () => {
	const refuses = (document, message) => assert.throws(() => loadAddresses(write(document)), message);
	const withContracts = contracts => book([demo({ contracts })]);
	refuses(withContracts({ core: CORE.slice(0, -1) }), /addresses\.json: deployment demo, contract Symmio: address must be a 0x… string/);
	refuses(book([demo(), demo()]), /deployment demo: id must be present and unique/);
	refuses(
		withContracts({ core: [{ address: CORE }, { address: OPERATOR }] }),
		/deployment demo, core at 0x999D.*: is the second Symmio here; give it a `name`/,
	);
	refuses(
		withContracts({ core: CORE, external: [{ address: OPERATOR }] }),
		/external at 0x999D.*: kind "external" does not say what the contract is, so it needs a `name`/,
	);
	refuses(withContracts({ core: CORE, safe: [{ owner: "Vibe", address: OPERATOR }] }), /Vibe's safe at .*needs a `name`/);
	// Contracts are grouped by kind, and a kind is one of those the app knows.
	refuses(withContracts([{ kind: "core", address: CORE }]), /deployment demo: expected `contracts` grouped by kind/);
	refuses(withContracts({ cores: CORE }), /deployment demo: "cores" is not a kind of contract/);
	refuses(withContracts({ core: CORE, safe: [OPERATOR] }), /deployment demo, safe: expected one address, or a list of entries/);
	// Two names that differ only in punctuation would otherwise share an id.
	refuses(
		withContracts({
			core: CORE,
			external: [
				{ owner: "Vibe", name: "Hook", address: OPERATOR },
				{ name: "Vibe Hook", address: OPERATOR },
			],
		}),
		/contract Vibe Hook: comes to the same id as another contract \(vibe-hook\)/,
	);
	// What ties the parts together is checked too: the chain a deployment names, and the deployments a wallet names.
	refuses(book([demo({ chain: "nowhere" })]), /deployment demo: chain "nowhere" is not listed under `chains`/);
	refuses(book([demo({ chain: undefined })]), /deployment demo: needs a `chain`/);
	refuses(book([demo()], { chains: { testnet: { chainId: "42161" } } }), /chain testnet: chainId must be a whole number/);
	refuses(
		book([demo()], { roleCandidates: [{ label: "Operator", deployments: ["gone"], wallets: [OPERATOR] }] }),
		/roleCandidates, Operator: names a deployment that is not in the file: gone/,
	);
	refuses(
		book([demo()], { roleCandidates: [{ label: "Operator", deployments: ["demo"], wallets: ["0x999"] }] }),
		/roleCandidates, Operator: wallet must be a 0x… string/,
	);
	refuses(
		book([demo()], { roleCandidates: [{ label: "", deployments: ["demo"], wallets: [OPERATOR] }] }),
		/roleCandidates, group 1: `label` must be text/,
	);
	refuses({ deployments: "nope" }, /expected a `deployments` list/);
	// A trailing comma is the usual slip when adding a line.
	refuses('{ "deployments": [], }', /addresses\.json: top level: not valid JSON/);
});
