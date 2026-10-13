import { ROOT } from "./build.js";
import { matchRuntime, codeHash } from "./model.js";
import { readRoleEvents, subgraphClient } from "./sources/subgraph.js";
import { Interface, ZeroAddress, getAddress, id } from "ethers";
import fs from "node:fs";
import path from "node:path";

export const ROLE_SOURCES = {
	core: "contracts/core/libraries/LibAccessibility.sol",
	accountLayer: "contracts/accountLayer/libraries/LibAccountLayerAccessibility.sol",
	express: "contracts/expressWithdrawLayer/libraries/LibAccessControl.sol",
	partyB: "contracts/helpers/accounts/SymmioPartyB.sol",
	liquidator: "contracts/helpers/accounts/SymmioLiquidator.sol",
	symbolManager: "contracts/helpers/symbolManager/SymmioSymbolManager.sol",
	gasless: "contracts/gaslessLayer/GaslessLayer.sol",
	instantLayer: "contracts/instantLayer/InstantLayer.sol",
	verifier: "contracts/helpers/verification/SymmioSignatureVerifier.sol",
	multiAccount: "contracts/helpers/accounts/MultiAccount.sol",
	feeDistributor: "contracts/helpers/governance/SymmioFeeDistributor.sol",
	timelock: "contracts/helpers/governance/SymmioTimelockController.sol",
};
export const diamondKind = kind => ["core", "accountLayer", "express"].includes(kind);
export function ensureNode(nodes, address, kind = "external", name = "Referenced address") {
	address = getAddress(address.toLowerCase());
	let n = nodes.find(n => n.address.toLowerCase() === address.toLowerCase());
	if (!n) {
		n = { id: `address:${address}`, address, kind, name, status: "referenced", state: {}, errors: [], strategy: "Inspect only" };
		nodes.push(n);
	}
	return n;
}
const eventVariants = [
	"event RoleGranted(bytes32 role,address user)",
	"event RoleRevoked(bytes32 role,address user)",
	"event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
	"event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)",
	"event RoleAdminAdded(bytes32 role,address admin)",
	"event RoleAdminRemoved(bytes32 role,address admin)",
	"event RoleAdminSet(bytes32 indexed role,address indexed account,bool status,address indexed sender)",
];
const setupVariants = [
	"event HookSet(address indexed affiliate,bytes4 indexed selector,address hook)",
	"event HookRemoved(address indexed affiliate,bytes4 indexed selector)",
	"event OperatorSet(address indexed affiliate,bytes4 indexed selector,address indexed operator,bool status)",
	"event HookAllowedSelectorsSet(address indexed affiliate,bytes4[] selectors,bool allowed)",
	"event CallAllowedSelectorsSet(address indexed affiliate,bytes4[] selectors,bool allowed)",
	"event RegisterAffiliate(address affiliate)",
	"event AffiliateRegistered(address indexed affiliate,string name)",
	"event TargetWhitelistUpdated(address indexed target,bool allowed)",
	"event WhitelistedSymmioCoreSet(address indexed core,bool status)",
	"event RegisterExpressProvider(address provider)",
	"event RegisterVirtualProvider(address provider)",
	"event RegisterHook(address affiliate,address hook)",
	"event AddBridge(address bridge)",
];
const setupInterfaces = setupVariants.map(s => new Interface([s]));
const eventInterfaces = eventVariants.map(s => new Interface([s]));
export const roleTopics = [...new Set(eventInterfaces.map(i => i.fragments[0].topicHash))];
export function parseRoleLog(log) {
	for (const iface of eventInterfaces)
		try {
			const e = iface.parseLog(log);
			if (e) return { hash: e.args[0], holder: e.args[1], admin: e.name.includes("Admin") };
		} catch {}
	return null;
}
// A bounded adaptive scan never represents a truncated history as complete.
export async function discoverRoleHistory(provider, nodes, blockNumber, onProgress = () => {}, maxRequests = 48) {
	const targets = nodes.filter(n => !["token", "authority", "safe"].includes(n.kind) && n.status === "observed");
	const pending = targets.length ? [[0, blockNumber]] : [];
	const logs = [];
	let requests = 0,
		failed = 0;
	while (pending.length && requests < maxRequests) {
		const batch = pending.splice(0, Math.min(4, maxRequests - requests));
		requests += batch.length;
		onProgress(`Discovering permission holders from events · ${requests} history requests`);
		await Promise.all(
			batch.map(async ([fromBlock, toBlock]) => {
				try {
					logs.push(
						...(await provider.getLogs({
							address: targets.map(n => n.address),
							fromBlock,
							toBlock,
							topics: [[...roleTopics, ...setupInterfaces.map(i => i.fragments[0].topicHash)]],
						})),
					);
				} catch {
					if (fromBlock === toBlock) {
						failed++;
						return;
					}
					const mid = Math.floor((fromBlock + toBlock) / 2);
					pending.push([fromBlock, mid], [mid + 1, toBlock]);
				}
			}),
		);
	}
	for (const log of logs) {
		const n = targets.find(n => n.address.toLowerCase() === log.address.toLowerCase());
		if (!n) continue;
		const e = parseRoleLog(log);
		if (e) {
			n.roleHistory ||= [];
			if (!n.roleHistory.some(r => r.hash === e.hash && r.holder === e.holder && r.admin === e.admin)) n.roleHistory.push(e);
			ensureNode(nodes, e.holder, "authority", "Permission holder");
			continue;
		}
		for (const iface of setupInterfaces)
			try {
				const event = iface.parseLog(log);
				if (!event) continue;
				n.setupHistory ||= [];
				n.setupHistory.push({
					name: event.name,
					args: JSON.parse(JSON.stringify(event.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
				});
				for (const [i, p] of event.fragment.inputs.entries())
					for (const a of addressesIn(p, event.args[i], p.name)) {
						if (a.address === ZeroAddress) continue;
						ensureNode(
							nodes,
							a.address,
							p.name === "affiliate" ? "affiliate" : p.name === "operator" ? "authority" : "external",
							`Discovered ${p.name}`,
						);
					}
				break;
			} catch {}
	}
	return {
		complete: !pending.length && !failed,
		requests,
		eventCount: logs.length,
		unreadRanges: pending.length + failed,
		fromBlock: 0,
		toBlock: blockNumber,
	};
}
/**
 * The same question as `discoverRoleHistory`, answered by the deployment's events subgraph instead of
 * the RPC. An indexer has already read every block, so it knows every address that was ever granted a
 * role, including on Diamonds whose roles cannot be listed from the chain. It only says where to look:
 * each holder it names is then checked with `hasRole` at the pinned block, and the chain's answer is
 * what is shown. Returns null when the profile names no events subgraph.
 */
export async function discoverRoleHistoryFromSubgraph({ nodes, links = [], blockNumber, onProgress = () => {}, client = subgraphClient }) {
	const link = links.find(l => /event/i.test(l.label || ""));
	if (!link) return null;
	const subgraph = client(link.url);
	onProgress(`Asking the ${subgraph.name} subgraph who has been granted roles`);
	const meta = await subgraph.meta();
	// Both lists are read at one indexed block, no later than the block the chain is read at.
	const pinned = Math.min(meta.block, blockNumber);
	const events = await readRoleEvents(subgraph, { block: pinned });
	const byAddress = new Map(nodes.filter(n => n.status === "observed").map(n => [n.address.toLowerCase(), n]));
	const outside = new Set();
	let holders = 0;
	for (const event of events.current) {
		const contract = byAddress.get(event.contract.toLowerCase());
		if (!contract) {
			outside.add(event.contract);
			continue;
		}
		contract.roleHistory ||= [];
		if (contract.roleHistory.some(r => r.hash === event.role && r.holder === event.holder && !r.admin)) continue;
		contract.roleHistory.push({
			hash: event.role,
			holder: event.holder,
			admin: false,
			tx: event.tx,
			block: event.block,
			timestamp: event.timestamp,
		});
		ensureNode(nodes, event.holder, "authority", "Role holder");
		holders++;
	}
	return {
		source: "subgraph",
		// As complete as the indexer: it has no gaps of its own unless it reports an indexing error.
		complete: !meta.hasIndexingErrors && !events.unreadable,
		subgraph: {
			label: link.label,
			name: subgraph.name,
			block: meta.block,
			behind: Math.max(0, blockNumber - meta.block),
			deployment: meta.deployment,
			hasIndexingErrors: meta.hasIndexingErrors,
		},
		eventCount: events.grants + events.revocations,
		grants: events.grants,
		revocations: events.revocations,
		unreadable: events.unreadable,
		holdersToConfirm: holders,
		contractsOutsideInventory: [...outside],
		requests: 0,
		unreadRanges: 0,
		fromBlock: 0,
		toBlock: pinned,
	};
}
const artifactRoots = {
	core: "contracts/core/facets",
	accountLayer: "contracts/accountLayer/facets",
	express: "contracts/expressWithdrawLayer/facets",
};
const abiCache = new Map();
export function nodeAbi(node) {
	return node.interfaceAbi ? new Interface(node.interfaceAbi) : contractAbi(node.kind);
}
export function contractAbi(kind) {
	if (abiCache.has(kind)) return abiCache.get(kind);
	const source = ROLE_SOURCES[kind];
	let files = [];
	const walk = dir => {
		if (!fs.existsSync(dir)) return;
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".json") && !e.name.endsWith(".dbg.json")) files.push(p);
		}
	};
	if (artifactRoots[kind]) walk(path.join(ROOT, "artifacts", artifactRoots[kind]));
	else if (source) walk(path.join(ROOT, "artifacts", source));
	const entries = new Map();
	for (const f of files) {
		const a = JSON.parse(fs.readFileSync(f));
		for (const entry of a.abi || []) {
			if (entry.type !== "function") continue;
			entries.set(JSON.stringify(entry), entry);
		}
	}
	const iface = new Interface([...entries.values()]);
	abiCache.set(kind, iface);
	return iface;
}
export function addressesIn(param, value, label) {
	if (value === undefined || value === null) return [];
	if (param.baseType === "address") return value === ZeroAddress ? [] : [{ address: value, label }];
	if (param.baseType === "array") return [...value].flatMap((v, i) => addressesIn(param.arrayChildren, v, `${label}[${i}]`));
	if (param.baseType === "tuple") return param.components.flatMap((p, i) => addressesIn(p, value[i], `${label}.${p.name || i}`));
	return [];
}
export async function inspectDependencies({ nodes, edges, read, onProgress = () => {} }) {
	const targets = [...nodes].filter(n => n.status === "observed" && (ROLE_SOURCES[n.kind] || n.interfaceAbi));
	const link = (n, address, label, kind = "pointer", basis = "Live configuration getter") => {
		const target = ensureNode(nodes, address, kind === "ownership" ? "authority" : kind === "implementation" ? "implementation" : "external");
		if (
			!edges.some(
				e => e.from === (kind === "ownership" ? target.id : n.id) && e.to === (kind === "ownership" ? n.id : target.id) && e.label === label,
			)
		)
			edges.push({
				from: kind === "ownership" ? target.id : n.id,
				to: kind === "ownership" ? n.id : target.id,
				label,
				kind,
				status: "verified",
				actual: address,
				basis,
			});
	};
	for (const n of targets) {
		onProgress(`Reading setup dependencies · ${n.name}`);
		const iface = nodeAbi(n);
		const reads = [];
		for (const f of iface.fragments) {
			if (f.type !== "function" || !["view", "pure"].includes(f.stateMutability)) continue;
			const hasAddresses = p =>
				p.baseType === "address" ||
				(p.baseType === "array" && hasAddresses(p.arrayChildren)) ||
				(p.baseType === "tuple" && p.components.some(hasAddresses));
			if (!f.outputs.some(hasAddresses)) continue;
			// Account/user/position getters describe application activity rather than deployment setup.
			if (f.inputs.length === 0 && !/^(getSigner|getSignerScope|pendingOwner|owner|getOwner|facets|facetAddresses)$/.test(f.name))
				reads.push({ f, args: [], label: f.name });
			if (
				f.inputs.length === 1 &&
				f.inputs[0].type === "address" &&
				/^(getAffiliate|getAffiliateAdmin|getAffiliateFeeDistributor|getAffiliateSymmioCores|getAffiliateStakeholders|getFeeCollector|getAffiliateHook)$/.test(
					f.name,
				)
			)
				for (const a of nodes.filter(a => a.kind === "affiliate"))
					reads.push({ f, args: [a.address], label: `${f.name} · ${a.name}`, origin: a });
		}
		for (let start = 0; start < reads.length; start += 12)
			await Promise.all(
				reads.slice(start, start + 12).map(async ({ f, args, label, origin }) => {
					try {
						const result = await read(n.address, f.format("full"), args);
						const values = f.outputs.length === 1 ? [result] : result;
						n.state.setup ||= {};
						n.state.setup[label] = result;
						for (const [i, p] of f.outputs.entries())
							for (const a of addressesIn(p, values[i], label + (f.outputs.length > 1 ? `.${p.name || i}` : "")))
								link(origin || n, a.address, a.label, "pointer", `Read from ${n.name}: ${f.format("sighash")}`);
					} catch {
						n.errors.push(`${label}: unavailable`);
					}
				}),
			);
	}
	// Owner and Safe members are discovered independently of contract family.
	for (const n of [...nodes].filter(n => n.status === "observed" && (!["token", "authority"].includes(n.kind) || n.state.owners?.length))) {
		if (!n.authority && n.kind !== "authority")
			try {
				const owner = await read(n.address, "function owner() view returns(address)");
				if (owner !== ZeroAddress) {
					n.state.owner = owner;
					link(n, owner, "Owner", "ownership");
				}
			} catch {}
		if (n.state.owners?.length) {
			for (const a of n.state.owners) link(n, a, "Safe owner", "ownership");
		} else if (n.kind === "safe")
			try {
				const owners = await read(n.address, "function getOwners() view returns(address[])");
				n.state.owners = owners;
				n.state.threshold = await read(n.address, "function getThreshold() view returns(uint256)");
				for (const a of owners) link(n, a, "Safe owner", "ownership");
			} catch {
				n.errors.push("Safe owners: unavailable");
			}
	}
	// Implementations and every observed facet are explicit, separate dependencies.
	for (const n of [...nodes]) {
		if (n.implementation) {
			link(n, n.implementation, "Proxy implementation", "implementation");
			const implementation = ensureNode(nodes, n.implementation, "implementation", "Implementation");
			implementation.codeHash = n.implementationCodeHash;
			implementation.codeSize = n.implementationCodeSize;
			implementation.status = n.implementationCodeSize > 0 ? "observed" : "no-code";
		}
		for (const f of n.diamond?.facets || []) {
			const facet = ensureNode(nodes, f.address, "facet", `Facet ${f.address.slice(0, 8)}`);
			facet.state.selectors = f.selectors;
			facet.codeHash = f.codeHash;
			facet.codeSize = (f.code.length - 2) / 2;
			facet.status = "observed";
			link(n, f.address, `Facet · ${f.selectors.length} selectors`, "facet");
		}
	}
}

let runtimeArtifacts;
export async function inspectRuntimeDependencies({ nodes, edges, provider, blockNumber, onProgress = () => {} }) {
	if (!runtimeArtifacts) {
		runtimeArtifacts = [];
		const walk = dir => {
			if (!fs.existsSync(dir)) return;
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith(".json") && !e.name.endsWith(".dbg.json")) {
					const a = JSON.parse(fs.readFileSync(p));
					if (a.deployedBytecode && a.deployedBytecode !== "0x") runtimeArtifacts.push(a);
				}
			}
		};
		walk(path.join(ROOT, "artifacts/contracts"));
	}
	const queue = nodes.filter(n => n.codeSize > 0 && !["authority", "safe", "token"].includes(n.kind));
	const checked = new Set();
	for (let i = 0; i < queue.length; i++) {
		const n = queue[i];
		if (checked.has(n.address.toLowerCase())) continue;
		checked.add(n.address.toLowerCase());
		onProgress(`Resolving deployed libraries · ${i + 1} of ${queue.length}`);
		let code;
		try {
			code = await provider.getCode(n.address, blockNumber);
		} catch {
			n.errors.push("Linked libraries: runtime unavailable");
			continue;
		}
		let match;
		for (const a of runtimeArtifacts) {
			let artifact = a;
			// Hardhat artifacts include the 0x prefix; library self-address is the first PUSH20.
			if (a.deployedBytecode.startsWith("0x730000000000000000000000000000000000000000"))
				artifact = { ...a, deployedBytecode: "0x73" + n.address.slice(2).toLowerCase() + a.deployedBytecode.slice(44) };
			const links = matchRuntime(artifact, code, n.address);
			if (links) {
				match = { a, links };
				break;
			}
		}
		if (!match) {
			n.libraryCoverage = "Unrecognized runtime: library bindings cannot be established from this checkout";
			continue;
		}
		n.libraryCoverage = "Exact runtime matched";
		n.artifact = match.a.sourceName + ":" + match.a.contractName;
		if (n.kind === "facet" || n.kind === "library") n.name = match.a.contractName;
		for (const [name, address] of Object.entries(match.links)) {
			const target = ensureNode(nodes, address, "library", name.split(":").at(-1));
			if (target.status === "referenced") {
				try {
					const c = await provider.getCode(address, blockNumber);
					target.codeHash = codeHash(c);
					target.codeSize = (c.length - 2) / 2;
					target.status = c === "0x" ? "no-code" : "observed";
				} catch {
					target.errors.push("Library runtime unavailable");
				}
			}
			edges.push({
				from: n.id,
				to: target.id,
				label: name.split(":").at(-1),
				kind: "library",
				actual: address,
				status: target.status === "observed" ? "verified" : target.status === "no-code" ? "missing" : "unknown",
				basis: "Library binding extracted from exact matching deployed bytecode",
			});
			queue.push(target);
		}
	}
}

const verifiedAbis = new Map();
async function verifiedAbi(chainId, address) {
	const key = `${chainId}:${address.toLowerCase()}`;
	if (verifiedAbis.has(key)) return verifiedAbis.get(key);
	let abi = null;
	try {
		const response = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=abi`, {
			signal: AbortSignal.timeout(5000),
		});
		if (response.ok) {
			const data = await response.json();
			if (Array.isArray(data.abi)) abi = data.abi;
		}
	} catch {}
	verifiedAbis.set(key, abi);
	return abi;
}
export async function loadVerifiedInterfaces(nodes, chainId, onProgress = () => {}) {
	if (chainId === 31337) return;
	const jobs = nodes
		.filter(n => n.status === "observed" && !["token", "safe", "authority", "facet", "library"].includes(n.kind))
		.map(n => async () => {
			const addresses = n.diamond?.facets.map(f => f.address) || [n.implementation || n.address];
			const all = [];
			for (let i = 0; i < addresses.length; i += 8)
				all.push(...(await Promise.all(addresses.slice(i, i + 8).map(a => verifiedAbi(chainId, a)))));
			const found = all.filter(Boolean);
			n.abiCoverage = { source: "Sourcify verified deployment ABI", found: found.length, total: addresses.length };
			// Keep local getters as fallbacks; deployed signatures take precedence by selector.
			const iface = contractAbi(n.kind),
				entries = new Map(iface.fragments.map(f => [f.type === "function" ? f.format("sighash") : f.format("full"), f.format("json")]));
			for (const abi of found)
				for (const f of new Interface(abi).fragments) if (f.type === "function") entries.set(f.format("sighash"), f.format("json"));
			if (found.length) n.interfaceAbi = [...entries.values()].map(s => JSON.parse(s));
		});
	for (let i = 0; i < jobs.length; i += 4) {
		onProgress(`Loading verified contract interfaces ${i + 1}–${Math.min(i + 4, jobs.length)} of ${jobs.length}`);
		await Promise.all(jobs.slice(i, i + 4).map(run => run()));
	}
}
