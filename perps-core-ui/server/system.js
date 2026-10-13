import { ADDRESSES_FILE, loadAddresses } from "./addresses.js";
import { ROOT } from "./build.js";
import { inspect } from "./chain.js";
import {
	ROLE_SOURCES,
	discoverRoleHistory,
	discoverRoleHistoryFromSubgraph,
	inspectDependencies,
	inspectRuntimeDependencies,
	loadVerifiedInterfaces,
} from "./discovery.js";
import { codeHash, digest, canonical } from "./model.js";
import { inspectRoleConnections } from "./roles.js";
import { inspectSetup } from "./setup.js";
import { batchedProvider } from "./sources/multicall.js";
import { Contract, Interface, ZeroAddress, ZeroHash, getAddress, id, toBeHex } from "ethers";
import fs from "node:fs";
import path from "node:path";

export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const COMPONENTS = {
	core: { title: "Core Diamond", strategy: "Diamond cut" },
	accountLayer: { title: "AccountLayer", strategy: "Diamond cut" },
	instantLayer: { title: "InstantLayer", strategy: "Replace and rewire", artifact: "InstantLayer" },
	partyB: { title: "PartyB", strategy: "UUPS implementation", artifact: "SymmioPartyB" },
	verifier: { title: "Signature verifier", strategy: "Replace and migrate configuration", artifact: "MuonSignatureVerifier" },
};
// Every deployment the app offers comes from the repository's address book.
export const defaultProfiles = loadAddresses().profiles;
export const suppliedProfile = defaultProfiles.find(p => p.id === "arbitrum-vibe");
export const serial = value => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
export function pointerConnections(from, actualId, label, actual, expectedNode) {
	const edges = [
		{
			from,
			to: actualId,
			label,
			actual,
			expected: expectedNode?.address || null,
			kind: "pointer",
			status: "verified",
			basis: "Observed configuration getter",
		},
	];
	if (expectedNode && expectedNode.address.toLowerCase() !== actual.toLowerCase())
		edges.push({
			from,
			to: expectedNode.id,
			label: `${label} · expected`,
			actual,
			expected: expectedNode.address,
			kind: "pointer",
			status: "mismatch",
			basis: "Pointer differs from the workspace inventory; review whether the inventory or deployment should change",
		});
	return edges;
}
export async function readCall(provider, target, signature, args = [], blockTag = "latest") {
	const iface = new Interface([signature]);
	const f = iface.fragments[0];
	const result = await provider.call({ to: target, data: iface.encodeFunctionData(f, args), blockTag });
	const values = iface.decodeFunctionResult(f, result);
	return serial(values.length === 1 ? values[0] : values);
}
export function validateProfile(profile) {
	if (!profile || !Number.isSafeInteger(profile.chainId) || profile.chainId < 1 || !Array.isArray(profile.nodes) || profile.nodes.length > 80)
		throw new Error("Provide a chain ID and at most 80 contracts");
	if (profile.id && !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id)) throw new Error("Invalid profile ID");
	const ids = new Set();
	const nodes = profile.nodes.map(n => {
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n.id) || ids.has(n.id)) throw new Error("Contract IDs must be unique");
		ids.add(n.id);
		return {
			id: n.id,
			name: String(n.name || n.id).slice(0, 100),
			kind: String(n.kind || "external"),
			address: getAddress(n.address.toLowerCase()),
			// Named by the profile, as opposed to an address the inspection came across on chain.
			listed: true,
			aliases: n.aliases,
		};
	});
	if (!nodes.some(n => n.id === "core" && n.kind === "core")) throw new Error("A Core contract is required");
	const expectedRoles = profile.expectedRoles || [];
	if (
		!Array.isArray(expectedRoles) ||
		expectedRoles.length > 200 ||
		expectedRoles.some(e => !ids.has(e.holder) || !ids.has(e.contract) || !/^[A-Z][A-Z0-9_]*_ROLE$/.test(e.role))
	)
		throw new Error("Expected roles require known holder/contract IDs and a role name");
	return {
		expectedRoles,
		environment: String(profile.environment || "Custom"),
		source:
			// A deployment from the address book names its entry there; one imported by hand may carry a link instead.
			profile.source && (profile.source.entry || /^https:\/\//.test(profile.source.url || ""))
				? {
						...(/^https:\/\//.test(profile.source.url || "") ? { url: profile.source.url } : {}),
						entry: String(profile.source.entry || ""),
						checked: String(profile.source.checked || ""),
					}
				: null,
		notes: (profile.notes || []).map(String),
		explorer: /^https:\/\//.test(profile.explorer || "") ? profile.explorer : null,
		roleCandidates: (profile.roleCandidates || [])
			.slice(0, 500)
			.map(r => ({ address: getAddress(r.address.toLowerCase()), name: String(r.name || "Inventory candidate") })),
		observedRoles: (profile.observedRoles || []).filter(r => ids.has(r.contract) && /^0x[0-9a-f]{64}$/i.test(r.hash)).slice(0, 200),
		id: profile.id || "custom",
		name: String(profile.name || "Deployment"),
		chainId: profile.chainId,
		version: profile.version,
		nodes,
		links: (profile.links || []).filter(link => {
			try {
				return new URL(link.url).protocol === "https:";
			} catch {
				return false;
			}
		}),
	};
}
const getters = {
	core: [
		["verifier", "getSignatureVerifier"],
		["collateral", "getCollateral"],
	],
	instantLayer: [
		["core", "symmio"],
		["accountLayer", "accountLayer"],
	],
	partyB: [
		["core", "symmioAddress"],
		["signer", "signer"],
	],
	gasless: [
		["core", "core"],
		["accountLayer", "accountLayer"],
		["instantLayer", "instantLayer"],
		["collateral", "collateralToken"],
		["treasury", "treasury"],
	],
	liquidator: [["core", "symmioAddress"]],
	symbolManager: [["core", "symmioAddress"]],
};
export async function inspectSystem(source, rawProfile, onProgress = () => {}) {
	const profile = validateProfile(rawProfile),
		network = await source.getNetwork();
	if (Number(network.chainId) !== profile.chainId) throw new Error(`RPC chain ${network.chainId} differs from profile chain ${profile.chainId}`);
	// Reads issued together are bundled into one request each, all answered at the pinned block.
	const provider = batchedProvider(source);
	const block = await provider.getBlock("latest");
	const at = block.number,
		edges = [],
		nodes = [],
		discovered = [];
	const byId = Object.fromEntries(profile.nodes.map(n => [n.id, n]));
	const scanNode = async supplied => {
		const n = { ...supplied, state: {}, errors: [], strategy: COMPONENTS[supplied.kind]?.strategy || "Inspect only", observedAt: at };
		try {
			const code = await provider.getCode(n.address, at);
			n.codeHash = codeHash(code);
			n.codeSize = (code.length - 2) / 2;
			const slot = await provider.getStorage(n.address, IMPLEMENTATION_SLOT, at);
			const implementation = getAddress(`0x${slot.slice(-40)}`);
			if (implementation !== ZeroAddress) {
				n.implementation = implementation;
				const implementationCode = await provider.getCode(implementation, at);
				n.implementationCodeHash = codeHash(implementationCode);
				n.implementationCodeSize = (implementationCode.length - 2) / 2;
				const admin = getAddress(
					`0x${(await provider.getStorage(n.address, toBeHex(BigInt(id("eip1967.proxy.admin")) - 1n, 32), at)).slice(-40)}`,
				);
				if (admin !== ZeroAddress) {
					n.proxyAdmin = admin;
					edges.push({ from: `address:${admin}`, to: n.id, label: "Proxy admin", kind: "ownership", status: "verified", actual: admin });
					if (![...profile.nodes, ...discovered].some(p => p.address.toLowerCase() === admin.toLowerCase()))
						discovered.push({ id: `address:${admin}`, name: "Proxy admin", kind: "proxyAdmin", address: admin });
				}
			}
			n.status = code === "0x" ? "no-code" : "observed";
			if (code === "0x") {
				nodes.push(n);
				return;
			}
			const read = async (key, signature, args = []) => {
				try {
					n.state[key] = await readCall(provider, n.address, signature, args, at);
					return n.state[key];
				} catch {
					n.errors.push(`${key}: unavailable`);
					return undefined;
				}
			};
			if (["core", "accountLayer", "express"].includes(n.kind)) {
				// inspect is pinned separately; reject rather than mix block snapshots.
				let d;
				try {
					d = await inspect(provider, n.address, at);
				} catch {
					n.errors.push("Diamond loupe/owner: unavailable");
				}
				if (d) {
					n.diamond = d;
					n.state.owner = d.owner;
					n.state.facets = d.facets.length;
					n.state.functions = Object.keys(d.map).length;
					n.authority = d.authority;
				}
			}
			for (const [target, method] of getters[n.kind] || []) {
				const value = await read(target, `function ${method}() view returns(address)`);
				if (value && value !== ZeroAddress) {
					const known = [...profile.nodes, ...discovered].find(peer => peer.address.toLowerCase() === value.toLowerCase());
					if (!known && ["core", "accountLayer", "instantLayer", "verifier", "collateral"].includes(target))
						discovered.push({
							id: `${target}-discovered-${value.slice(2, 10)}`,
							name: `${target} (on-chain reference)`,
							kind: target === "collateral" ? "token" : target,
							address: value,
						});
					edges.push(
						...pointerConnections(
							n.id,
							[...profile.nodes, ...discovered].find(peer => peer.address.toLowerCase() === value.toLowerCase())?.id ||
								`address:${value}`,
							method,
							value,
							byId[target],
						),
					);
				} else if (byId[target])
					edges.push({
						from: n.id,
						to: target,
						label: method,
						kind: "pointer",
						actual: value ?? null,
						expected: byId[target].address,
						status: value === ZeroAddress ? "missing" : "unknown",
					});
			}
			if (["partyB", "liquidator", "symbolManager", "accountLayer"].includes(n.kind))
				await read("paused", "function paused() view returns(bool)");
			if (["instantLayer", "verifier"].includes(n.kind)) {
				n.state.roles = {};
				for (const name of [
					"DEFAULT_ADMIN_ROLE",
					"SETTER_ROLE",
					...(n.kind === "instantLayer" ? ["OPERATOR_ROLE", "TEMPLATE_MANAGER_ROLE", "REVOKER_ROLE"] : []),
				]) {
					const role = name === "DEFAULT_ADMIN_ROLE" ? ZeroHash : id(name);
					try {
						const count = Number(
							await readCall(provider, n.address, "function getRoleMemberCount(bytes32) view returns(uint256)", [role], at),
						);
						if (count > 100) throw new Error("Too many members");
						n.state.roles[name] = await Promise.all(
							Array.from({ length: count }, (_, i) =>
								readCall(provider, n.address, "function getRoleMember(bytes32,uint256) view returns(address)", [role, i], at),
							),
						);
					} catch {
						n.errors.push(`${name}: members unavailable`);
					}
				}
			}
			if (n.kind === "instantLayer") {
				await read("templates", "function getNextTemplateId() view returns(uint256)");
				await read("revocationCooldown", "function revocationCooldown() view returns(uint256)");
				await read("transientContextEnabled", "function transientContextEnabled() view returns(bool)");
			}
			if (n.kind === "verifier") {
				await read("publicKeys", "function getAllPublicKeys() view returns((uint256 x,uint8 parity)[])");
				await read("gatewaySigners", "function getAllGatewaySigners() view returns(address[])");
			}
			if (n.kind === "token") {
				await read("symbol", "function symbol() view returns(string)");
				await read("decimals", "function decimals() view returns(uint8)");
			}
		} catch (error) {
			n.status = "unavailable";
			n.errors.push(
				String(error.shortMessage || error.message)
					.replace(/https?:\/\/\S+/g, "<rpc>")
					.slice(0, 200),
			);
		}
		nodes.push(n);
	};
	for (let start = 0; start < profile.nodes.length; start += 4) {
		onProgress(`Inspecting contracts ${start + 1}–${Math.min(start + 4, profile.nodes.length)} of ${profile.nodes.length}`);
		await Promise.all(profile.nodes.slice(start, start + 4).map(scanNode));
	}
	for (let i = 0; i < discovered.length && i < 40; i++)
		if (!nodes.some(n => n.address.toLowerCase() === discovered[i].address.toLowerCase())) await scanNode(discovered[i]);
	nodes.sort((a, b) => profile.nodes.findIndex(n => n.id === a.id) - profile.nodes.findIndex(n => n.id === b.id));

	const relation = async (from, to, label, signature, args) => {
		if (!byId[from] || !byId[to]) return;
		try {
			const value = await readCall(provider, byId[from].address, signature, args, at);
			edges.push({ from, to, label, kind: "membership", status: value ? "verified" : "missing", actual: value, expected: true });
		} catch {
			edges.push({ from, to, label, kind: "membership", status: "unknown", actual: null, expected: true });
		}
	};
	if (byId.accountLayer)
		await relation("accountLayer", "core", "Core allowlist", "function isWhitelistedSymmioCore(address) view returns(bool)", [byId.core.address]);
	for (const p of profile.nodes.filter(n => n.kind === "partyB")) {
		await relation("core", p.id, "Registered solver", "function isPartyB(address) view returns(bool)", [p.address]);
		await relation("instantLayer", p.id, "PartyB enrollment", "function registeredPartyBs(address) view returns(bool)", [p.address]);
	}
	const authorities = new Map();
	for (const n of [...nodes]) {
		const members = n.authority ? [n.authority.address] : n.state.roles?.DEFAULT_ADMIN_ROLE || [];
		for (const owner of members) {
			if (!authorities.has(owner)) {
				const existing = nodes.find(peer => peer.address.toLowerCase() === owner.toLowerCase());
				if (existing) {
					authorities.set(owner, existing);
				} else {
					const code = await provider.getCode(owner, at);
					const a = {
						id: authorities.size === 0 ? "governance" : `governance-${authorities.size}`,
						name: n.authority?.kind === "safe" ? "Governance Safe" : "Admin authority",
						kind: "authority",
						address: owner,
						status: "observed",
						strategy: "Authorizes upgrades",
						state: { ...(n.authority?.threshold ? { threshold: n.authority.threshold, owners: n.authority.owners } : {}) },
						codeHash: codeHash(code),
						codeSize: (code.length - 2) / 2,
						errors: [],
					};
					authorities.set(owner, a);
					nodes.push(a);
				}
			}
			if (n.authority)
				edges.push({
					kind: "ownership",
					from: authorities.get(owner).id,
					to: n.id,
					label: n.authority ? "Diamond owner" : "DEFAULT_ADMIN_ROLE",
					actual: owner,
					status: "verified",
				});
		}
	}
	const read = (target, signature, args) => readCall(provider, target, signature, args, at);
	await loadVerifiedInterfaces(nodes, profile.chainId, onProgress);
	// An events subgraph knows every role holder; the RPC's own event scan is the fallback, and public
	// endpoints often refuse it. Either way the grants themselves are read from the chain below.
	let roleHistory = null,
		subgraphError;
	try {
		roleHistory = await discoverRoleHistoryFromSubgraph({ nodes, links: profile.links, blockNumber: at, onProgress });
	} catch (error) {
		subgraphError = String(error.message).slice(0, 300);
	}
	if (!roleHistory)
		roleHistory = {
			...(await discoverRoleHistory(provider, nodes, at, onProgress)),
			source: "logs",
			...(subgraphError ? { subgraphError } : {}),
		};
	await inspectDependencies({ nodes, edges, read, onProgress });
	await inspectSetup({ nodes, edges, read, profile, onProgress });
	await inspectRuntimeDependencies({ nodes, edges, provider, blockNumber: at, onProgress });
	edges.push(
		...(await inspectRoleConnections({
			nodes,
			profile,
			onProgress,
			read: (target, signature, args) => readCall(provider, target, signature, args, at),
		})),
	);
	for (const e of edges)
		for (const key of ["from", "to"])
			if (e[key].startsWith("address:")) {
				const n = nodes.find(n => n.address.toLowerCase() === e[key].slice(8).toLowerCase());
				if (n) e[key] = n.id;
			}
	const body = { chainId: profile.chainId, nodes, edges };
	return {
		...body,
		profile,
		blockNumber: at,
		blockHash: block.hash,
		at: new Date().toISOString(),
		fingerprint: digest(body),
		roleHistory,
		// Where each kind of fact in this snapshot came from, so the interface can say so.
		sources: {
			inventory: {
				// A profile imported by hand in the app did not come from the address book.
				file: profile.source?.entry ? ADDRESSES_FILE : null,
				entry: profile.source?.entry || null,
				url: profile.source?.url || null,
				checked: profile.source?.checked || null,
				contracts: profile.nodes.length,
				candidates: (profile.roleCandidates || []).length,
			},
			chain: {
				block: at,
				blockHash: block.hash,
				timestamp: block.timestamp,
				discovered: Math.max(0, nodes.length - profile.nodes.length),
				reads: { ...provider.readStats },
			},
			history: roleHistory,
			abis: {
				verified: nodes.filter(n => n.interfaceAbi).length,
				local: nodes.filter(n => n.artifact || ROLE_SOURCES[n.kind]).length,
			},
			checks: {
				expectedGrants: edges.filter(e => e.kind === "role" && e.expected === true).length,
				comparedPointers: edges.filter(e => e.kind === "pointer" && e.expected !== undefined && e.expected !== null).length,
			},
		},
		coverage: `Roles, role administrators, setup getters, hooks, allowlists, facets and proxy implementations are read at block ${at}. ${roleHistory.source === "subgraph" ? `Role holders were found through the ${roleHistory.subgraph.name} subgraph (${roleHistory.grants} grants, ${roleHistory.revocations} revocations) and each one confirmed on chain.` : roleHistory.complete ? "Role event history scanned from genesis." : "Role event history is incomplete on this RPC; inventory and enumerable holders were still checked."} External contracts without local ABIs and non-enumerable mapping keys may need additional inventory. Red = missing required connection; gray = unavailable or optional unset.`,
	};
}
export function systemDiff(previous, current) {
	if (!previous) return [];
	const changes = [];
	// `kind` says what an entry is about: the contract itself, a value it holds, or a connection it has.
	const contract = n => ({ kind: "contract", node: n.id, name: n.name, nodeKind: n.kind });
	for (const n of current.nodes) {
		const p = previous.nodes.find(v => v.id === n.id);
		if (!p) {
			changes.push({ ...contract(n), field: "contract", before: null, after: n.address });
			continue;
		}
		for (const key of ["address", "codeHash", "implementation", "implementationCodeHash", "status"]) {
			if (canonical(p[key]) !== canonical(n[key])) changes.push({ ...contract(n), field: key, before: p[key] ?? null, after: n[key] ?? null });
		}
		for (const key of new Set([...Object.keys(p.state), ...Object.keys(n.state)]))
			if (canonical(p.state[key]) !== canonical(n.state[key]))
				changes.push({ kind: "state", node: n.id, name: n.name, field: key, before: p.state[key] ?? null, after: n.state[key] ?? null });
	}
	const present = new Set(current.nodes.map(n => n.id));
	for (const p of previous.nodes) if (!present.has(p.id)) changes.push({ ...contract(p), field: "contract", before: p.address, after: null });
	const edgeKey = e => [e.from, e.to, e.kind, e.label].join(":");
	const oldEdges = new Map(previous.edges.map(e => [edgeKey(e), e])),
		newEdges = new Map(current.edges.map(e => [edgeKey(e), e]));
	for (const key of new Set([...oldEdges.keys(), ...newEdges.keys()])) {
		const before = oldEdges.get(key),
			after = newEdges.get(key),
			edge = after || before;
		if (canonical(before?.actual) !== canonical(after?.actual) || before?.status !== after?.status)
			changes.push({
				kind: "connection",
				node: edge.from,
				to: edge.to,
				label: edge.label,
				edgeKind: edge.kind,
				field: `${edge.label} → ${edge.to}`,
				before: before ? { value: before.actual, status: before.status } : null,
				after: after ? { value: after.actual, status: after.status } : null,
			});
	}
	return changes;
}
