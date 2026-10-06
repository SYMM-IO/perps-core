import { MUON_FUNCTIONS } from "../muon-functions.js";
import { operationDigest } from "./inputs.js";
import { Interface, getAddress, id, keccak256, toBeHex, ZeroAddress, ZeroHash } from "ethers";

export const MUON_UPGRADE_ABI = [
	"function getSignatureVerifier() view returns(address)",
	"function getMuonIds() view returns(uint256)",
	"function getMuonConfig() view returns(uint256 upnlValidTime,uint256 priceValidTime)",
	"function getMuonFunctionUpnlValidTime(uint8) view returns(uint256 upnlValidTime,bool isOverridden)",
	"function getAllPublicKeys() view returns((uint256 x,uint8 parity)[])",
	"function getAllGatewaySigners() view returns(address[])",
	"function supportsMuonFunction(uint8) view returns(bool)",
	"function isPublicKeyAuthorized((uint256 x,uint8 parity),uint8) view returns(bool)",
	"function isGatewaySignerAuthorized(address,uint8) view returns(bool)",
	"function getRoleAdmin(bytes32) view returns(bytes32)",
	"function getRoleMemberCount(bytes32) view returns(uint256)",
	"function getRoleMember(bytes32,uint256) view returns(address)",
	"function hasRole(bytes32,address) view returns(bool)",
];
const iface = new Interface(MUON_UPGRADE_ABI);
const standardRoles = [ZeroHash, id("SETTER_ROLE")];
const address = value => {
	const result = getAddress(value);
	if (result === ZeroAddress) throw new Error("Muon identity cannot be zero");
	return result;
};
const same = (a, b, label) => {
	if (operationDigest(a) !== operationDigest(b)) throw new Error(`Muon ${label} changed`);
};
export function muonUpgradePolicy(input = {}) {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).some(key => !["requiredFunctions", "additionalVerifierRoles", "maxRoleMembers", "maxSigners"].includes(key))
	)
		throw new Error("Invalid Muon upgrade policy");
	const policy = {
		requiredFunctions: input.requiredFunctions ?? MUON_FUNCTIONS.filter(f => f.name !== "ExpressCredit").map(f => f.name),
		additionalVerifierRoles: input.additionalVerifierRoles ?? [],
		maxRoleMembers: input.maxRoleMembers ?? 100,
		maxSigners: input.maxSigners ?? 100,
	};
	if (
		!Array.isArray(policy.requiredFunctions) ||
		!policy.requiredFunctions.length ||
		new Set(policy.requiredFunctions).size !== policy.requiredFunctions.length ||
		policy.requiredFunctions.some(name => !MUON_FUNCTIONS.some(f => f.name === name)) ||
		!Array.isArray(policy.additionalVerifierRoles) ||
		policy.additionalVerifierRoles.some(role => !/^0x[0-9a-fA-F]{64}$/.test(role)) ||
		new Set([...standardRoles, ...policy.additionalVerifierRoles].map(role => role.toLowerCase())).size !==
			standardRoles.length + policy.additionalVerifierRoles.length ||
		![policy.maxRoleMembers, policy.maxSigners].every(n => Number.isSafeInteger(n) && n > 0)
	)
		throw new Error("Invalid Muon functions, roles or enumeration limits");
	return policy;
}
export function validateMuonProfile(profile) {
	if (
		profile?.schemaVersion !== 1 ||
		profile.kind !== "symmio.muon-upgrade-profile" ||
		Object.keys(profile).some(key => !["schemaVersion", "kind", "chainId", "core", "verifier", "policy"].includes(key)) ||
		!Number.isSafeInteger(profile.chainId) ||
		profile.chainId < 1
	)
		throw new Error("Invalid Muon upgrade profile");
	for (const contract of [profile.core, profile.verifier]) {
		address(contract?.address);
		if (Object.keys(contract).sort().join(",") !== "address,codeHash" || !/^0x[0-9a-fA-F]{64}$/.test(contract.codeHash))
			throw new Error("Muon profile needs exact runtime bindings");
	}
	muonUpgradePolicy(profile.policy);
	return profile;
}
async function pinnedBlock(provider, chainId, checkpoint) {
	if (
		!checkpoint ||
		!Number.isSafeInteger(checkpoint.blockNumber) ||
		checkpoint.blockNumber < 0 ||
		!/^0x[0-9a-fA-F]{64}$/.test(checkpoint.blockHash)
	)
		throw new Error("Invalid Muon checkpoint");
	const tag = toBeHex(checkpoint.blockNumber),
		block = await provider.send("eth_getBlockByNumber", [tag, false]);
	if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId) || block?.hash?.toLowerCase() !== checkpoint.blockHash.toLowerCase())
		throw new Error("Muon checkpoint is not canonical on this chain");
	return { tag, block };
}
async function read(provider, target, method, args, tag) {
	const decoded = iface.decodeFunctionResult(
		method,
		await provider.send("eth_call", [{ to: target, data: iface.encodeFunctionData(method, args) }, tag]),
	);
	return decoded.length === 1 ? decoded[0] : decoded;
}

/** Enumerated configuration only. Neither InstantLayer user records nor raw storage are read. */
export async function captureMuonConfiguration(provider, profile, checkpoint) {
	validateMuonProfile(profile);
	const policy = muonUpgradePolicy(profile.policy),
		{ tag } = await pinnedBlock(provider, profile.chainId, checkpoint);
	for (const contract of [profile.core, profile.verifier]) {
		const code = await provider.send("eth_getCode", [contract.address, tag]);
		if (code === "0x" || keccak256(code) !== contract.codeHash.toLowerCase()) throw new Error("Muon contract runtime changed");
	}
	const core = address(profile.core.address),
		verifier = address(profile.verifier.address);
	if (getAddress(await read(provider, core, "getSignatureVerifier", [], tag)) !== verifier) throw new Error("Core Muon verifier pointer differs");
	const appId = String(await read(provider, core, "getMuonIds", [], tag));
	const windows = await read(provider, core, "getMuonConfig", [], tag);
	const functions = [];
	for (const func of MUON_FUNCTIONS) {
		const supported = await read(provider, verifier, "supportsMuonFunction", [func.index], tag);
		// ExpressCredit uses its provider's freshness window, not Core UPNL validity.
		const validity = func.name === "ExpressCredit" ? null : await read(provider, core, "getMuonFunctionUpnlValidTime", [func.index], tag);
		functions.push({ ...func, supported, validity: validity ? { seconds: String(validity[0]), overridden: validity[1] } : null });
	}
	const keys = await read(provider, verifier, "getAllPublicKeys", [], tag),
		gateways = await read(provider, verifier, "getAllGatewaySigners", [], tag);
	if (keys.length > policy.maxSigners || gateways.length > policy.maxSigners)
		throw new Error(`Signature Verifier (${verifier}) maxSigners: Muon signer inventory exceeds reviewed limit`);
	const publicKeys = [],
		gatewaySigners = [];
	for (const key of keys) {
		const publicKey = { x: String(key.x), parity: Number(key.parity) },
			permissions = [];
		for (const func of functions) permissions.push(await read(provider, verifier, "isPublicKeyAuthorized", [publicKey, func.index], tag));
		publicKeys.push({ publicKey, permissions });
	}
	for (const gateway of gateways) {
		const signer = address(gateway),
			permissions = [];
		for (const func of functions) permissions.push(await read(provider, verifier, "isGatewaySignerAuthorized", [signer, func.index], tag));
		gatewaySigners.push({ signer, permissions });
	}
	const roles = [];
	for (const role of [...standardRoles, ...policy.additionalVerifierRoles].sort()) {
		const count = BigInt(await read(provider, verifier, "getRoleMemberCount", [role], tag));
		if (count > BigInt(policy.maxRoleMembers))
			throw new Error(`Signature Verifier (${verifier}) maxRoleMembers: Muon role inventory exceeds reviewed limit`);
		const members = [];
		for (let i = 0; i < Number(count); i++) {
			const member = address(await read(provider, verifier, "getRoleMember", [role, i], tag));
			if (!(await read(provider, verifier, "hasRole", [role, member], tag))) throw new Error("Muon role enumeration is inconsistent");
			members.push(member);
		}
		if (new Set(members).size !== members.length) throw new Error("Duplicate Muon role members");
		roles.push({ role, adminRole: await read(provider, verifier, "getRoleAdmin", [role], tag), members: members.sort() });
	}
	await pinnedBlock(provider, profile.chainId, checkpoint);
	return {
		schemaVersion: 1,
		kind: "symmio.muon-configuration",
		profileDigest: operationDigest(profile),
		checkpoint,
		configuration: { appId, upnlValidTime: String(windows[0]), priceValidTime: String(windows[1]), functions, publicKeys, gatewaySigners, roles },
	};
}

export async function verifyMuonConfiguration(provider, profile, snapshot, checkpoint, reviewedDigest) {
	if (operationDigest(snapshot) !== reviewedDigest || snapshot?.profileDigest !== operationDigest(profile))
		throw new Error("Reviewed Muon evidence changed");
	const historical = await captureMuonConfiguration(provider, profile, snapshot.checkpoint);
	same(snapshot, historical, "historical configuration");
	const current = await captureMuonConfiguration(provider, profile, checkpoint);
	same(snapshot.configuration, current.configuration, "configuration");
	return current;
}
