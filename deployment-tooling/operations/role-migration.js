import { operationDigest } from "./inputs.js";
import { Interface, getAddress, keccak256, toBeHex, ZeroAddress } from "ethers";

const access = new Interface([
	"function hasRole(bytes32 role,address account) view returns(bool)",
	"function getRoleAdmin(bytes32 role) view returns(bytes32)",
	"function getRoleMemberCount(bytes32 role) view returns(uint256)",
	"function getRoleMember(bytes32 role,uint256 index) view returns(address)",
	"function grantRole(bytes32 role,address account)",
]);
const hash = value => /^0x[0-9a-fA-F]{64}$/.test(value);
const address = value => {
	const result = getAddress(value);
	if (result === ZeroAddress) throw new Error("Role migration address cannot be zero");
	return result;
};
export function validateRoleProfile(profile) {
	if (profile.schemaVersion !== 1 || !Number.isSafeInteger(profile.chainId) || profile.chainId < 1 || !Array.isArray(profile.transitions))
		throw new Error("Invalid role migration profile");
	for (const contract of [profile.source, profile.target]) {
		address(contract?.address);
		if (!hash(contract?.codeHash)) throw new Error("Missing role contract runtime binding");
	}
	const ids = new Set(),
		roles = new Set();
	for (const row of profile.transitions) {
		if (
			!/^[a-z][a-z0-9.-]*$/.test(row.id || "") ||
			ids.has(row.id) ||
			![row.sourceRole, row.targetRole, row.adminRole, row.sourceAdminRole === undefined ? row.adminRole : row.sourceAdminRole].every(hash) ||
			roles.has(row.targetRole.toLowerCase()) ||
			row.policy !== "exact-source-members"
		)
			throw new Error("Role transitions need unique IDs and target roles with an explicit supported membership policy");
		address(row.authority);
		ids.add(row.id);
		roles.add(row.targetRole.toLowerCase());
	}
}
async function checkpoint(provider, chainId, value) {
	if (!Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0 || !hash(value.blockHash))
		throw new Error("Invalid role migration checkpoint");
	const tag = toBeHex(value.blockNumber),
		block = await provider.send("eth_getBlockByNumber", [tag, false]);
	if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId) || block?.hash?.toLowerCase() !== value.blockHash.toLowerCase())
		throw new Error("Role checkpoint chain or block changed");
	return tag;
}
async function runtime(provider, contract, tag) {
	const code = await provider.send("eth_getCode", [address(contract.address), tag]);
	if (code === "0x" || keccak256(code) !== contract.codeHash.toLowerCase()) throw new Error("Role migration runtime changed");
}
async function read(provider, target, name, args, tag) {
	return access.decodeFunctionResult(
		name,
		await provider.send("eth_call", [{ to: address(target), data: access.encodeFunctionData(name, args) }, tag]),
	)[0];
}
async function authority(provider, profile, row, tag) {
	if (
		(await read(provider, profile.target.address, "getRoleAdmin", [row.targetRole], tag)).toLowerCase() !== row.adminRole.toLowerCase() ||
		!(await read(provider, profile.target.address, "hasRole", [row.adminRole, address(row.authority)], tag))
	)
		throw new Error("Role migration admin or authority differs");
}

/** Enumerate only declared roles through their bounded standard views. */
export async function readRoleInventory(provider, profile, atBlock, maxMembersPerRole) {
	validateRoleProfile(profile);
	if (!Number.isSafeInteger(maxMembersPerRole) || maxMembersPerRole < 1) throw new Error("Provide a positive role enumeration limit");
	const tag = await checkpoint(provider, profile.chainId, atBlock);
	await runtime(provider, profile.source, tag);
	const inventory = [];
	for (const role of new Set(profile.transitions.map(row => row.sourceRole.toLowerCase()))) {
		const count = await read(provider, profile.source.address, "getRoleMemberCount", [role], tag);
		if (count > BigInt(maxMembersPerRole)) throw new Error("Role enumeration limit exceeded; no partial inventory was accepted");
		const members = [];
		for (let index = 0n; index < count; index++) {
			const member = address(await read(provider, profile.source.address, "getRoleMember", [role, index], tag));
			if (!(await read(provider, profile.source.address, "hasRole", [role, member], tag))) throw new Error("Enumerated role member differs");
			members.push(member);
		}
		if (new Set(members).size !== members.length) throw new Error("Enumerated role members are duplicated");
		inventory.push({ role, members: members.sort() });
	}
	await checkpoint(provider, profile.chainId, atBlock);
	return inventory;
}

/** Explicit capability changes. Count + distinct positive memberships prove the supplied role list is complete. */
export async function captureRoleMigration(provider, profile, sourceRoles, checkpoints) {
	validateRoleProfile(profile);
	const sourceTag = await checkpoint(provider, profile.chainId, checkpoints.source),
		targetTag = await checkpoint(provider, profile.chainId, checkpoints.target);
	await runtime(provider, profile.source, sourceTag);
	await runtime(provider, profile.target, targetTag);
	const observations = [];
	for (const row of profile.transitions) {
		if (
			(await read(provider, profile.source.address, "getRoleAdmin", [row.sourceRole], sourceTag)).toLowerCase() !==
			(row.sourceAdminRole || row.adminRole).toLowerCase()
		)
			throw new Error("Source role administrator differs from the reviewed transition");
		const roles = sourceRoles.filter(role => role.role.toLowerCase() === row.sourceRole.toLowerCase());
		if (roles.length !== 1 || !Array.isArray(roles[0].members)) throw new Error("Source role inventory is missing or duplicated");
		const members = roles[0].members.map(address);
		if (
			new Set(members).size !== members.length ||
			BigInt(members.length) !== (await read(provider, profile.source.address, "getRoleMemberCount", [row.sourceRole], sourceTag))
		)
			throw new Error("Source role member inventory is incomplete or duplicated");
		const alreadyGranted = [];
		for (const member of members) {
			if (!(await read(provider, profile.source.address, "hasRole", [row.sourceRole, member], sourceTag)))
				throw new Error("Source role member differs from the inventory");
			if (await read(provider, profile.target.address, "hasRole", [row.targetRole, member], targetTag)) alreadyGranted.push(member);
		}
		if (BigInt(alreadyGranted.length) !== (await read(provider, profile.target.address, "getRoleMemberCount", [row.targetRole], targetTag)))
			throw new Error("Target role has unexpected members; select an explicit transformation policy");
		await authority(provider, profile, row, targetTag);
		observations.push({ id: row.id, members, alreadyGranted });
	}
	await checkpoint(provider, profile.chainId, checkpoints.source);
	await checkpoint(provider, profile.chainId, checkpoints.target);
	return { schemaVersion: 1, profileDigest: operationDigest(profile), inventoryDigest: operationDigest(sourceRoles), checkpoints, observations };
}

export function buildRoleMigration(profile, snapshot) {
	validateRoleProfile(profile);
	if (
		snapshot.schemaVersion !== 1 ||
		snapshot.profileDigest !== operationDigest(profile) ||
		snapshot.observations.length !== profile.transitions.length ||
		new Set(snapshot.observations.map(row => row.id)).size !== profile.transitions.length
	)
		throw new Error("Role migration snapshot binding changed");
	const actions = [],
		checks = [];
	for (const row of profile.transitions) {
		const observed = snapshot.observations.find(item => item.id === row.id);
		if (
			!observed ||
			!Array.isArray(observed.members) ||
			!Array.isArray(observed.alreadyGranted) ||
			new Set(observed.members.map(address)).size !== observed.members.length ||
			new Set(observed.alreadyGranted.map(address)).size !== observed.alreadyGranted.length ||
			observed.alreadyGranted.some(member => !observed.members.includes(member))
		)
			throw new Error("Invalid role migration observation");
		for (const member of observed.members)
			if (!observed.alreadyGranted.includes(member))
				actions.push({
					id: `${row.id}.${member.toLowerCase()}`,
					to: address(profile.target.address),
					value: "0",
					data: access.encodeFunctionData("grantRole", [row.targetRole, member]),
					authority: address(row.authority),
					description: `Preserve ${row.id} capability for ${member}`,
				});
		checks.push({ ...row, members: observed.members });
	}
	const plan = {
		schemaVersion: 1,
		chainId: profile.chainId,
		target: profile.target,
		profileDigest: snapshot.profileDigest,
		snapshotDigest: operationDigest(snapshot),
		actions,
		checks,
	};
	return { ...plan, planDigest: operationDigest(plan) };
}

export async function verifyRoleMigration(provider, plan, block) {
	const { planDigest, ...content } = plan;
	if (operationDigest(content) !== planDigest) throw new Error("Role migration plan changed");
	const tag = await checkpoint(provider, plan.chainId, block);
	await runtime(provider, plan.target, tag);
	for (const row of plan.checks) {
		await authority(provider, plan, row, tag);
		if ((await read(provider, plan.target.address, "getRoleMemberCount", [row.targetRole], tag)) !== BigInt(row.members.length))
			throw new Error("Role post-state member count differs");
		for (const member of row.members)
			if (!(await read(provider, plan.target.address, "hasRole", [row.targetRole, member], tag)))
				throw new Error("Role post-state membership differs");
	}
	await checkpoint(provider, plan.chainId, block);
	return { planDigest, blockNumber: block.blockNumber, blockHash: block.blockHash, transitions: plan.checks.length };
}
