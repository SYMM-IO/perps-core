import { ROOT } from "./build.js";
import { id as hashOf } from "ethers";
import fs from "node:fs";
import path from "node:path";

/** The repository's address book: every deployment the app knows. */
export const ADDRESSES_FILE = "addresses.json";

const fail = (where, message) => {
	throw new Error(`${ADDRESSES_FILE}: ${where}: ${message}`);
};

// Contracts a deployment has one of, where the kind says everything: the id the app's rules use, and the name shown.
const STANDARD = {
	core: ["core", "Symmio"],
	token: ["collateral", "Collateral"],
	accountLayer: ["accountLayer", "Account Layer"],
	instantLayer: ["instantLayer", "Instant Layer"],
	gasless: ["gasless", "Gasless Layer"],
	express: ["express", "Express Provider"],
	verifier: ["verifier", "Muon Signature Verifier"],
	symbolManager: ["symbolManager", "Symbol Manager"],
	liquidator: ["liquidator", "Liquidator Proxy"],
};
// What a solver's or frontend's contract of a kind is called, after the owner's name.
const OWNED = { partyB: "PartyB", multiAccount: "MultiAccount", affiliate: "Affiliate", feeDistributor: "Fee Collector" };
// Kinds that do not say what the contract is, so each entry carries a name.
const NAMED = ["safe", "timelock", "authority", "external"];
const KINDS = [...Object.keys(STANDARD), ...Object.keys(OWNED), ...NAMED];
const slug = text =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
const isAddress = value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * A deployment's contracts are grouped by kind. A kind holds one address when there is nothing more
 * to say (`"core": "0x…"`), or a list of entries. This flattens the groups into one list.
 */
function listed(contracts, where) {
	if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) fail(where, "expected `contracts` grouped by kind");
	return Object.entries(contracts).flatMap(([kind, entries]) => {
		if (!KINDS.includes(kind)) fail(where, `"${kind}" is not a kind of contract; the kinds are ${KINDS.join(", ")}`);
		if (typeof entries === "string") return [{ kind, address: entries }];
		if (!Array.isArray(entries) || entries.some(e => !e || typeof e !== "object"))
			fail(`${where}, ${kind}`, "expected one address, or a list of entries");
		return entries.map(entry => ({ ...entry, kind }));
	});
}

/**
 * Gives every contract its name and id. The file says a thing once: the kind it is listed under, an
 * `owner` when the contract belongs to a solver or a frontend, and a `name` only where the kind does
 * not already say what it is. So under `partyB`, `{ owner: "PerpsHub" }` is "PerpsHub · PartyB" and
 * the next one "PerpsHub · PartyB 2", and `"core": "0x…"` is "Symmio". Ids follow from the names.
 */
function named(contracts, where) {
	const count = new Map();
	return contracts.map(({ kind, owner, name: given, address, ...rest }) => {
		const at = `${where}, ${owner ? `${owner}'s ` : ""}${given || kind} at ${address}`;
		const own = given ?? (owner ? OWNED[kind] : STANDARD[kind]?.[1]);
		if (!own) fail(at, `kind "${kind}" does not say what the contract is, so it needs a \`name\``);
		const base = owner ? `${owner} · ${own}` : own,
			nth = (count.get(base) || 0) + 1;
		count.set(base, nth);
		// A solver can have several PartyBs. A deployment with two cores has one too many, or one that needs naming.
		if (nth > 1 && !owner && given === undefined) fail(at, `is the second ${own} here; give it a \`name\` that tells the two apart`);
		const name = nth === 1 ? base : `${base} ${nth}`;
		// The first contract of a standard kind keeps the id the app's rules refer to; every other id is the name.
		const id = !owner && given === undefined ? STANDARD[kind][0] : slug(name);
		if (!isAddress(address)) fail(`${where}, contract ${name}`, "address must be a 0x… string of 40 hex digits");
		return { ...rest, id, name, kind, address };
	});
}

/**
 * Reads `addresses.json` into the profiles the app works with. The file writes each thing once and
 * this puts it back together per deployment: the chain's details, the role candidates that list the
 * deployment, and the older role names to look for on its core. It is edited by hand, so the slips
 * that are easy to make are refused with the entry's name: a mistyped address, an unknown chain or
 * deployment, a duplicated id, a chain id in quotes.
 */
export function loadAddresses(file = path.join(ROOT, ADDRESSES_FILE)) {
	let document;
	try {
		document = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		fail("top level", `not valid JSON (${error.message})`);
	}
	if (!document || !Array.isArray(document.deployments)) fail("top level", "expected a `deployments` list");
	const checked = document.checked === undefined ? undefined : String(document.checked),
		chains = document.chains || {};
	for (const [name, chain] of Object.entries(chains))
		if (!Number.isSafeInteger(chain?.chainId)) fail(`chain ${name}`, "chainId must be a whole number");

	const ids = new Set();
	for (const d of document.deployments) {
		const where = `deployment ${d?.id ?? "(no id)"}`;
		if (typeof d?.id !== "string" || ids.has(d.id)) fail(where, "id must be present and unique");
		ids.add(d.id);
	}
	// A wallet worth checking for roles is written once, with every deployment to check it on. A group may carry
	// the `label` the wallets are known by; the roles they hold are read from the chain either way.
	const wallets = new Map();
	for (const [index, group] of (document.roleCandidates || []).entries()) {
		const where = `roleCandidates, ${typeof group?.label === "string" && group.label ? group.label : `group ${index + 1}`}`;
		if (group?.label !== undefined && (typeof group.label !== "string" || !group.label)) fail(where, "`label` must be text when given");
		if (!Array.isArray(group?.deployments) || !Array.isArray(group.wallets)) fail(where, "needs a `deployments` list and a `wallets` list");
		for (const wallet of group.wallets) if (!isAddress(wallet)) fail(where, `wallet must be a 0x… string of 40 hex digits: ${wallet}`);
		for (const id of group.deployments) {
			if (!ids.has(id)) fail(where, `names a deployment that is not in the file: ${id}`);
			wallets.set(id, [...(wallets.get(id) || []), ...group.wallets.map(address => ({ address, name: group.label || "Role candidate" }))]);
		}
	}
	// Role names this checkout no longer defines, or hashes nobody has a name for, to look for on every core.
	const olderRoles = (document.olderCoreRoles || []).map(role =>
		/^0x[0-9a-f]{64}$/i.test(role)
			? { contract: "core", name: "UNKNOWN_ROLE", hash: role.toLowerCase() }
			: { contract: "core", name: String(role), hash: hashOf(String(role)) },
	);

	const profiles = document.deployments.map(d => {
		const where = `deployment ${d.id}`,
			chain = chains[d.chain];
		if (!chain) fail(where, d.chain ? `chain "${d.chain}" is not listed under \`chains\`` : "needs a `chain`");
		const name = String(d.name ?? d.id),
			seen = new Set();
		return {
			id: d.id,
			name,
			chainId: chain.chainId,
			// The chain's key in the file, such as "arbitrum": a name an operator recognises before the id.
			chainName: d.chain,
			rpc: chain.rpc,
			explorer: chain.explorer,
			// A version written without quotes, such as 0.8, would otherwise arrive as a number.
			version: d.version === undefined ? undefined : String(d.version),
			environment: d.environment,
			source: { entry: name, checked },
			nodes: named(listed(d.contracts, where), where).map(node => {
				// Two names can differ only in punctuation and still come to one id.
				if (seen.has(node.id))
					fail(`${where}, contract ${node.name}`, `comes to the same id as another contract (${node.id}); change one of the names`);
				seen.add(node.id);
				return node;
			}),
			// The app finds a deployment's indexers by label; "Events" is the one it uses to discover role holders.
			links: Object.entries(d.subgraphs || {}).map(([key, url]) => ({ label: key[0].toUpperCase() + key.slice(1), url })),
			notes: d.notes || [],
			roleCandidates: wallets.get(d.id) || [],
			...(olderRoles.length ? { observedRoles: olderRoles } : {}),
		};
	});
	return { checked, chains, frontends: document.frontends || {}, profiles };
}
