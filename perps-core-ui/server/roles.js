import { ROOT } from "./build.js";
import { ROLE_SOURCES, diamondKind, ensureNode, contractAbi, nodeAbi } from "./discovery.js";
import { id, ZeroHash } from "ethers";
import fs from "node:fs";
import path from "node:path";

// Only authorization checks justify a required integration grant. The unused
// AccountLayer INSTANT_LAYER_ROLE must never become a missing-role warning.
export const EXPECTED_ROLES = [
	["instantLayer", "core", "INSTANT_LAYER_ROLE"],
	["instantLayer", "accountLayer", "SIGNER_SETTER_ROLE"],
	["gasless", "accountLayer", "ACCOUNT_CREATOR_ROLE"],
	["gasless", "instantLayer", "OPERATOR_ROLE"],
	["liquidator", "core", "LIQUIDATOR_ROLE"],
	["liquidator", "core", "PARTYB_LIQUIDATOR_ROLE"],
	["symbolManager", "core", "SYMBOL_MANAGER_ROLE"],
	["symbolManager", "core", "SYMBOL_LISTING_ROLE"],
	["symbolManager", "core", "FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"],
];
export function roleNames(kind) {
	const source = ROLE_SOURCES[kind];
	if (!source) return [];
	const names = [...fs.readFileSync(path.join(ROOT, source), "utf8").matchAll(/bytes32 public constant (\w+_ROLE)\s*=/g)].map(m => m[1]);
	for (const f of contractAbi(kind).fragments) if (f.type === "function" && f.name.endsWith("_ROLE") && f.inputs.length === 0) names.push(f.name);
	return [...new Set(["DEFAULT_ADMIN_ROLE", ...names])];
}
export function roleHash(kind, name) {
	return name === "DEFAULT_ADMIN_ROLE" && !diamondKind(kind) ? ZeroHash : id(name);
}
export async function inspectRoleConnections({ nodes, profile, read, onProgress = () => {}, signal }) {
	const edges = [],
		seen = new Set();
	let expectations = [...EXPECTED_ROLES, ...(profile.expectedRoles || []).map(e => [e.holder, e.contract, e.role])];
	for (const n of nodes.filter(n => n.kind === "partyB"))
		expectations.push(["instantLayer", n.id, "TRUSTED_ROLE"], [n.id, "instantLayer", "OPERATOR_ROLE"]);
	// Roles introduced by the 0.8.6 integration, verified against actual facet guards.
	if (/^0\.8\.6/.test(profile.version || ""))
		for (const name of ["SIGNER_ADMIN_ROLE", "AFFILIATE_MANAGER_ROLE", "AFFILIATE_REGISTRAR_ROLE", "BALANCE_SETTLER_ROLE"])
			expectations.push(["accountLayer", "core", name]);
	// A role added to this checkout must not become a missing grant on an older
	// deployment. Explicit profile requirements remain the operator's intent.
	const explicit = new Set((profile.expectedRoles || []).map(e => [e.holder, e.contract, e.role].join(":")));
	expectations = expectations.filter(parts => {
		if (explicit.has(parts.join(":"))) return true;
		const contract = nodes.find(n => n.id === parts[1]);
		return !contract?.diamond || contract.diamond.facets.some(f => f.code.toLowerCase().includes(roleHash(contract.kind, parts[2]).slice(2)));
	});
	const expected = new Set(expectations.map(p => p.join(":")));
	const granted = (contract, hash, holder) => {
		const record = (contract.roleHistory || []).find(
			r => !r.admin && r.tx && r.hash.toLowerCase() === hash.toLowerCase() && r.holder.toLowerCase() === holder.address.toLowerCase(),
		);
		return record && { tx: record.tx, block: record.block, timestamp: record.timestamp };
	};
	const add = (holder, contract, role, status, hash, kind = "role", basis) => {
		const key = [holder.id, contract.id, hash, kind].join(":");
		if (seen.has(key)) return;
		seen.add(key);
		edges.push({
			from: holder.id,
			to: contract.id,
			label: kind === "roleAdmin" ? `Admin · ${role}` : role,
			kind,
			status,
			actual: status === "unknown" ? null : status === "verified",
			expected: kind === "role" && expected.has([holder.id, contract.id, role].join(":")) ? true : null,
			basis: basis || (expected.has([holder.id, contract.id, role].join(":")) ? "Expected integration grant" : "Observed role grant"),
			roleHash: hash,
			// When an indexer recorded the grant, keep the transaction: the chain says the role is held, this says since when.
			...(kind === "role" && granted(contract, hash, holder) ? { grant: granted(contract, hash, holder) } : {}),
			holder: holder.address,
			contract: contract.address,
		});
	};
	// Candidate inventory is never permission evidence until the pinned live read succeeds.
	for (const r of profile.roleCandidates || []) ensureNode(nodes, r.address, "authority", r.name || "Inventory candidate");
	const contracts = [...nodes].filter(n => n.status === "observed" && (ROLE_SOURCES[n.kind] || n.roleHistory?.length || n.interfaceAbi));
	for (const [index, n] of contracts.entries()) {
		signal?.throwIfAborted();
		onProgress(`Reading role catalogues and members · ${n.name}`, index, contracts.length);
		const selectors = n.diamond ? new Set(n.diamond.facets.flatMap(f => f.selectors)) : null;
		const supports = signature => !selectors || selectors.has(id(signature).slice(0, 10));
		const customOrder = diamondKind(n.kind) && supports("hasRole(address,bytes32)");
		n.roleInterface = {
			addressFirst: customOrder,
			customAdmin: diamondKind(n.kind) && supports("isRoleAdmin(address,bytes32)"),
			adminRole: !diamondKind(n.kind) || (selectors && supports("getRoleAdmin(bytes32)")),
			enumerable: !diamondKind(n.kind) || (selectors && supports("getRoleMemberCount(bytes32)") && supports("getRoleMember(bytes32,uint256)")),
		};
		if (diamondKind(n.kind) && !n.roleInterface.customAdmin && !n.roleInterface.adminRole) {
			n.adminReadFailures = 1;
			n.errors.push("Role administrators: this deployment exposes no administrator getter");
		}
		const roles = new Map(roleNames(n.kind).map(name => [roleHash(n.kind, name), name]));
		for (const f of nodeAbi(n).fragments)
			if (f.type === "function" && f.name.endsWith("_ROLE") && !f.inputs.length)
				try {
					const hash = await read(n.address, f.format("full"));
					if (/^0x[0-9a-f]{64}$/i.test(hash)) {
						for (const [old, name] of roles) if (name === f.name) roles.delete(old);
						roles.set(hash, f.name);
					}
				} catch {}
		for (const r of profile.observedRoles || [])
			if (r.contract === n.id) roles.set(r.hash, r.name === "UNKNOWN_ROLE" ? `Role ${r.hash.slice(0, 10)}` : r.name);
		for (const r of n.roleHistory || []) if (!roles.has(r.hash)) roles.set(r.hash, `Role ${r.hash.slice(0, 10)}`);
		for (const [h, c, name] of expectations) if (c === n.id) roles.set(roleHash(n.kind, name), name);
		for (const name of Object.keys(n.state.roles || {})) roles.set(roleHash(n.kind, name), name);
		n.roleCatalog = [...roles].map(([hash, name]) => ({ name, hash }));
		n.state.roles ||= {};
		n.roleAdmins = {};
		// OpenZeppelin enumerable contracts expose complete membership per role.
		for (const [hash, name] of roles) {
			if (n.roleInterface.enumerable && !n.state.roles[name])
				try {
					const raw = await read(n.address, "function getRoleMemberCount(bytes32) view returns(uint256)", [hash]);
					if (!/^[0-9]+$/.test(String(raw))) throw Error("Invalid count");
					const count = Number(raw);
					if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw Error("Member limit");
					const members = [];
					for (let offset = 0; offset < count; offset += 24)
						members.push(
							...(await Promise.all(
								Array.from({ length: Math.min(24, count - offset) }, (_, i) =>
									read(n.address, "function getRoleMember(bytes32,uint256) view returns(address)", [hash, offset + i]),
								),
							)),
						);
					n.state.roles[name] = members;
				} catch {}
			for (const address of n.state.roles[name] || []) add(ensureNode(nodes, address, "authority", "Role holder"), n, name, "verified", hash);
			if (n.roleInterface.adminRole)
				try {
					n.roleAdmins[hash] = await read(n.address, "function getRoleAdmin(bytes32) view returns(bytes32)", [hash]);
				} catch {}
		}
	}
	const candidates = [...nodes].filter(n => !["facet", "implementation", "library"].includes(n.kind));
	const jobs = [];
	for (const n of contracts)
		for (const { name, hash } of n.roleCatalog)
			for (const holder of candidates) {
				const needed = expected.has([holder.id, n.id, name].join(":"));
				if (!n.state.roles[name])
					jobs.push(async () => {
						try {
							const yes = await read(
								n.address,
								n.roleInterface.addressFirst
									? "function hasRole(address,bytes32) view returns(bool)"
									: "function hasRole(bytes32,address) view returns(bool)",
								n.roleInterface.addressFirst ? [holder.address, hash] : [hash, holder.address],
							);
							if (yes || needed) {
								const guardUnavailable =
									diamondKind(n.kind) && n.observedAt != null && !n.diamond && !explicit.has([holder.id, n.id, name].join(":"));
								add(
									holder,
									n,
									name,
									yes ? "verified" : guardUnavailable ? "unknown" : "missing",
									hash,
									"role",
									guardUnavailable && !yes ? "Role absent; deployed authorization guard could not be checked" : undefined,
								);
							}
						} catch {
							n.roleReadFailures = (n.roleReadFailures || 0) + 1;
							if (
								needed ||
								(n.roleHistory || []).some(
									r => !r.admin && r.hash === hash && r.holder.toLowerCase() === holder.address.toLowerCase(),
								)
							)
								add(holder, n, name, "unknown", hash);
						}
					});
				else if (needed && !n.state.roles[name].some(a => a.toLowerCase() === holder.address.toLowerCase()))
					add(holder, n, name, "missing", hash);
				if (n.roleInterface.customAdmin)
					jobs.push(async () => {
						try {
							if (await read(n.address, "function isRoleAdmin(address,bytes32) view returns(bool)", [holder.address, hash]))
								add(holder, n, name, "verified", hash, "roleAdmin", "Effective role administrator (includes DEFAULT_ADMIN_ROLE)");
						} catch {
							n.adminReadFailures = (n.adminReadFailures || 0) + 1;
							if (
								(n.roleHistory || []).some(r => r.admin && r.hash === hash && r.holder.toLowerCase() === holder.address.toLowerCase())
							)
								add(holder, n, name, "unknown", hash, "roleAdmin", "Administrator read unavailable");
						}
					});
			}
	// Each round is a couple of bundled requests when the chain has Multicall3, and plain parallel reads when it does not.
	for (let offset = 0; offset < jobs.length; offset += 192) {
		signal?.throwIfAborted();
		onProgress(
			`Checking role grants and administrators ${offset + 1}–${Math.min(offset + 192, jobs.length)} of ${jobs.length}`,
			offset,
			jobs.length,
		);
		await Promise.all(jobs.slice(offset, offset + 192).map(run => run()));
	}
	for (const n of contracts)
		for (const { name, hash } of n.roleCatalog) {
			const adminHash = n.roleAdmins[hash];
			if (!adminHash) continue;
			for (const grant of [...edges].filter(e => e.to === n.id && e.kind === "role" && e.status === "verified" && e.roleHash === adminHash)) {
				const holder = nodes.find(h => h.id === grant.from);
				add(holder, n, name, "verified", hash, "roleAdmin", `Admin role ${adminHash}`);
			}
		}
	for (const [holderId, contractId, name] of expectations) {
		const holder = nodes.find(n => n.id === holderId),
			contract = nodes.find(n => n.id === contractId);
		if (!holder || !contract) continue;
		const hash = contract.roleCatalog?.find(r => r.name === name)?.hash || roleHash(contract.kind, name);
		if (!seen.has([holder.id, contract.id, hash, "role"].join(":"))) add(holder, contract, name, "unknown", hash);
	}
	return edges.sort((a, b) => `${a.from}:${a.to}:${a.label}`.localeCompare(`${b.from}:${b.to}:${b.label}`));
}
