import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"

export type KnownOwnershipAccount = {
	label: string
	address?: string
}

export type UpgradeOwnershipSummaryInput = {
	symmioCore?: string
	accountLayer?: string
	instantLayer?: string
	signatureVerifier?: string
	symbolManager?: string
	symmioPartyBImplementation?: string
	knownAccounts?: KnownOwnershipAccount[]
}

type KnownAccountIndex = Map<string, string[]>

type RoleReadMode = "enumerable" | "known-accounts"

type RoleSpec = {
	name: string
	mode: RoleReadMode
	hash?: string
}

const CUSTOM_DEFAULT_ADMIN_ROLE = ethers.id("DEFAULT_ADMIN_ROLE")
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase()

const DIAMOND_OWNERSHIP_ABI = [
	"function owner() view returns (address)",
	"function pendingOwner() view returns (address)",
	"function hasRole(address user, bytes32 role) view returns (bool)",
]

const ACCESS_CONTROL_ENUMERABLE_ABI = [
	"function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
	"function SETTER_ROLE() view returns (bytes32)",
	"function OPERATOR_ROLE() view returns (bytes32)",
	"function REVOKER_ROLE() view returns (bytes32)",
	"function PAUSER_ROLE() view returns (bytes32)",
	"function UNPAUSER_ROLE() view returns (bytes32)",
	"function TRUSTED_ROLE() view returns (bytes32)",
	"function MANAGER_ROLE() view returns (bytes32)",
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function getRoleMemberCount(bytes32 role) view returns (uint256)",
	"function getRoleMember(bytes32 role, uint256 index) view returns (address)",
]

const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ERC1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

export async function logUpgradeOwnershipSummary(input: UpgradeOwnershipSummaryInput): Promise<void> {
	const knownAccounts = normalizeKnownAccounts(input.knownAccounts ?? [])
	const contracts = [
		input.symmioCore,
		input.accountLayer,
		input.instantLayer,
		input.signatureVerifier,
		input.symbolManager,
		input.symmioPartyBImplementation,
	].filter(Boolean)

	if (contracts.length === 0) {
		log.warn("No ownership addresses available to inspect")
		return
	}

	log.header("Ownership / Admin Summary")

	await logDiamondOwnership("Symmio Core Diamond", input.symmioCore, knownAccounts)
	await logDiamondOwnership("AccountLayer Diamond", input.accountLayer, knownAccounts)
	await logAccessControlOwnership("InstantLayer", input.instantLayer, knownAccounts, [
		{ name: "DEFAULT_ADMIN_ROLE", mode: "enumerable" },
		{ name: "SETTER_ROLE", mode: "enumerable" },
		{ name: "OPERATOR_ROLE", mode: "enumerable" },
		{ name: "REVOKER_ROLE", mode: "enumerable" },
	])
	await logAccessControlOwnership("MuonSignatureVerifier", input.signatureVerifier, knownAccounts, [
		{ name: "DEFAULT_ADMIN_ROLE", mode: "enumerable" },
		{ name: "SETTER_ROLE", mode: "enumerable" },
	])
	await logAccessControlOwnership("SymmioSymbolManager", input.symbolManager, knownAccounts, [
		{ name: "DEFAULT_ADMIN_ROLE", mode: "enumerable" },
		{ name: "SETTER_ROLE", mode: "enumerable" },
		{ name: "PAUSER_ROLE", mode: "enumerable" },
		{ name: "UNPAUSER_ROLE", mode: "enumerable" },
	])
	await logAccessControlOwnership("SymmioPartyB implementation", input.symmioPartyBImplementation, knownAccounts, [
		{ name: "DEFAULT_ADMIN_ROLE", mode: "known-accounts", hash: ethers.ZeroHash },
		{ name: "TRUSTED_ROLE", mode: "known-accounts" },
		{ name: "MANAGER_ROLE", mode: "known-accounts" },
		{ name: "PAUSER_ROLE", mode: "known-accounts" },
		{ name: "UNPAUSER_ROLE", mode: "known-accounts" },
		{ name: "SETTER_ROLE", mode: "known-accounts" },
	])
}

async function logDiamondOwnership(label: string, address: string | undefined, knownAccounts: KnownAccountIndex): Promise<void> {
	const normalized = await normalizeInspectableAddress(label, address)
	if (!normalized) return

	const contract = new ethers.Contract(normalized, DIAMOND_OWNERSHIP_ABI, ethers.provider)
	const owner = await safeReadAddress(() => contract.owner())
	const pendingOwner = await safeReadAddress(() => contract.pendingOwner())
	const roleCandidates = withDynamicKnownAccounts(knownAccounts, [
		{ label: `${label} owner`, address: owner },
		{ label: `${label} pendingOwner`, address: pendingOwner },
	])

	log.info(`${label}: ${log.addr(normalized)}`)
	log.kv("Owner", formatAddress(owner, knownAccounts), 4)
	log.kv("Pending owner", formatAddress(pendingOwner, knownAccounts), 4)

	await logKnownAccountRoleMembers(contract, "DEFAULT_ADMIN_ROLE", CUSTOM_DEFAULT_ADMIN_ROLE, roleCandidates, true)
	await logErc1967Slots(normalized, knownAccounts)
	log.blank()
}

async function logAccessControlOwnership(
	label: string,
	address: string | undefined,
	knownAccounts: KnownAccountIndex,
	roles: RoleSpec[],
): Promise<void> {
	const normalized = await normalizeInspectableAddress(label, address)
	if (!normalized) return

	const contract = new ethers.Contract(normalized, ACCESS_CONTROL_ENUMERABLE_ABI, ethers.provider)

	log.info(`${label}: ${log.addr(normalized)}`)
	await logErc1967Slots(normalized, knownAccounts)

	for (const role of roles) {
		const roleHash = role.hash ?? (await resolveRoleHash(contract, role.name))
		if (!roleHash) continue

		if (role.mode === "enumerable") {
			const members = await readEnumerableRoleMembers(contract, roleHash)
			if (members) {
				logRoleMembers(role.name, members, knownAccounts)
				continue
			}
		}

		await logKnownAccountRoleMembers(contract, role.name, roleHash, knownAccounts, false)
	}

	log.blank()
}

async function normalizeInspectableAddress(label: string, address: string | undefined): Promise<string | undefined> {
	if (!address) return undefined
	if (!ethers.isAddress(address) || address.toLowerCase() === ZERO_ADDRESS) {
		log.warn(`${label}: invalid or zero address ${address}`)
		return undefined
	}

	const normalized = ethers.getAddress(address)
	const code = await ethers.provider.getCode(normalized)
	if (!code || code === "0x") {
		log.warn(`${label}: no code at ${normalized}`)
		return undefined
	}
	return normalized
}

async function resolveRoleHash(contract: any, roleName: string): Promise<string | undefined> {
	try {
		if (roleName === "DEFAULT_ADMIN_ROLE") return await contract.DEFAULT_ADMIN_ROLE()
		return await contract[roleName]()
	} catch {
		return undefined
	}
}

async function readEnumerableRoleMembers(contract: any, roleHash: string): Promise<string[] | undefined> {
	try {
		const count = BigInt(await contract.getRoleMemberCount(roleHash))
		const members: string[] = []
		for (let index = 0n; index < count; index++) {
			members.push(ethers.getAddress(await contract.getRoleMember(roleHash, index)))
		}
		return members
	} catch {
		return undefined
	}
}

async function logKnownAccountRoleMembers(
	contract: any,
	roleName: string,
	roleHash: string,
	knownAccounts: KnownAccountIndex,
	customRoleOrder: boolean,
): Promise<void> {
	const members: string[] = []
	for (const address of knownAccounts.keys()) {
		try {
			const hasRole = customRoleOrder ? await contract.hasRole(address, roleHash) : await contract.hasRole(roleHash, address)
			if (hasRole) members.push(ethers.getAddress(address))
		} catch {
			return
		}
	}

	if (members.length > 0) {
		logRoleMembers(roleName, members, knownAccounts, "(known accounts only)")
	} else if (knownAccounts.size > 0) {
		log.kv(roleName, "(none among known accounts; role is not enumerable here)", 4)
	} else {
		log.kv(roleName, "(not enumerable; no known accounts supplied)", 4)
	}
}

function logRoleMembers(roleName: string, members: string[], knownAccounts: KnownAccountIndex, suffix = ""): void {
	const note = suffix ? ` ${suffix}` : ""
	log.kv(roleName, `${members.length} member(s)${note}`, 4)
	for (const member of members) {
		log.detail(formatAddress(member, knownAccounts))
	}
}

async function logErc1967Slots(address: string, knownAccounts: KnownAccountIndex): Promise<void> {
	const [implementation, admin] = await Promise.all([
		readAddressFromStorageSlot(address, ERC1967_IMPLEMENTATION_SLOT),
		readAddressFromStorageSlot(address, ERC1967_ADMIN_SLOT),
	])
	if (implementation) log.kv("ERC1967 implementation", formatAddress(implementation, knownAccounts), 4)
	if (admin) log.kv("ERC1967 admin", formatAddress(admin, knownAccounts), 4)
}

async function readAddressFromStorageSlot(address: string, slot: string): Promise<string | undefined> {
	try {
		const raw = await ethers.provider.getStorage(address, slot)
		const parsed = ethers.getAddress(`0x${raw.slice(-40)}`)
		return parsed.toLowerCase() === ZERO_ADDRESS ? undefined : parsed
	} catch {
		return undefined
	}
}

async function safeReadAddress(read: () => Promise<string>): Promise<string | undefined> {
	try {
		const value = await read()
		return ethers.isAddress(value) ? ethers.getAddress(value) : undefined
	} catch {
		return undefined
	}
}

function formatAddress(address: string | undefined, knownAccounts: KnownAccountIndex): string {
	if (!address || address.toLowerCase() === ZERO_ADDRESS) return "(none)"
	const normalized = ethers.getAddress(address)
	const labels = knownAccounts.get(normalized.toLowerCase())
	return `${log.addr(normalized)}${labels?.length ? ` (${labels.join(", ")})` : ""}`
}

function normalizeKnownAccounts(accounts: KnownOwnershipAccount[]): KnownAccountIndex {
	const knownAccounts: KnownAccountIndex = new Map()
	for (const account of accounts) {
		if (!account.address || !ethers.isAddress(account.address) || account.address.toLowerCase() === ZERO_ADDRESS) continue
		const normalized = ethers.getAddress(account.address).toLowerCase()
		const labels = knownAccounts.get(normalized) ?? []
		if (!labels.includes(account.label)) labels.push(account.label)
		knownAccounts.set(normalized, labels)
	}
	return knownAccounts
}

function withDynamicKnownAccounts(knownAccounts: KnownAccountIndex, accounts: KnownOwnershipAccount[]): KnownAccountIndex {
	const merged: KnownOwnershipAccount[] = []
	for (const [address, labels] of knownAccounts.entries()) {
		for (const label of labels) merged.push({ label, address })
	}
	merged.push(...accounts)
	return normalizeKnownAccounts(merged)
}
