import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readDataIfExists } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { checksumAddress, getConnection, requireArg } from "./helpers.js"
import { logger } from "./logger.js"

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

export type StandaloneDeploymentKind = "feeDistributor" | "multiAccount" | "multicall"
export type StandaloneDeploymentPhase = "preflight" | "poststate"

export type CheckStandaloneDeploymentArgs = {
	kind: StandaloneDeploymentKind
	phase: StandaloneDeploymentPhase
	address?: string
	symmioAddress?: string
	admin?: string
	symmioShareReceiver?: string
	symmioShare?: string
}

const RECORD_NAMES: Record<StandaloneDeploymentKind, string> = {
	feeDistributor: "SymmioFeeDistributorProxy",
	multiAccount: "MultiAccountProxy",
	multicall: "Multicall3",
}

function requireKind(value: string): StandaloneDeploymentKind {
	if (value === "feeDistributor" || value === "multiAccount" || value === "multicall") return value
	throw new Error(`Unsupported standalone deployment kind: ${value}`)
}

function requirePhase(value: string): StandaloneDeploymentPhase {
	if (value === "preflight" || value === "poststate") return value
	throw new Error(`Unsupported standalone deployment check phase: ${value}`)
}

function requireUint(value: string | undefined, name: string): bigint {
	const raw = requireArg(value, name)
	if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned integer`)
	return BigInt(raw)
}

function recordedAddress(ethers: any, kind: StandaloneDeploymentKind): string {
	const records = readDataIfExists(DEPLOYMENT_LOG_FILE)
	if (!Array.isArray(records)) throw new Error(`Deployment data ${DEPLOYMENT_LOG_FILE} must contain a JSON array`)
	const name = RECORD_NAMES[kind]
	const record = records.find((entry: any) => entry?.name === name)
	if (!record?.address) throw new Error(`Deployment record ${name} is missing from ${DEPLOYMENT_LOG_FILE}`)
	if (!ethers.isAddress(record.address) || record.address === ethers.ZeroAddress) {
		throw new Error(`Deployment record ${name} has an invalid address`)
	}
	return ethers.getAddress(record.address)
}

async function requireCode(ethers: any, address: string, label: string): Promise<void> {
	if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${label} has no bytecode at ${address}`)
}

async function requireProxyImplementation(ethers: any, proxy: string, label: string): Promise<void> {
	const raw = await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT)
	const implementation = ethers.getAddress(`0x${raw.slice(-40)}`)
	if (implementation === ethers.ZeroAddress) throw new Error(`${label} has no EIP-1967 implementation`)
	await requireCode(ethers, implementation, `${label} implementation`)
}

function requireEqualAddress(ethers: any, actual: string, expected: string, label: string): void {
	if (ethers.getAddress(actual) !== expected) throw new Error(`${label} is ${actual}, expected ${expected}`)
}

export async function checkStandaloneDeployment(hre: any, raw: CheckStandaloneDeploymentArgs): Promise<string | null> {
	const kind = requireKind(raw.kind)
	const phase = requirePhase(raw.phase)
	const { ethers } = await getConnection(hre)

	let symmioAddress: string | undefined
	let admin: string | undefined
	let receiver: string | undefined
	let share: bigint | undefined
	if (kind !== "multicall") {
		symmioAddress = checksumAddress(requireArg(raw.symmioAddress, "symmio-address"))
		admin = checksumAddress(requireArg(raw.admin, "admin"))
		await requireCode(ethers, symmioAddress, "SYMMIO Core")
	}
	if (kind === "feeDistributor") {
		receiver = checksumAddress(requireArg(raw.symmioShareReceiver, "symmio-share-receiver"))
		share = requireUint(raw.symmioShare, "symmio-share")
		if (share > 10n ** 18n) throw new Error("symmio-share must not exceed 1e18")
	}

	if (phase === "preflight") {
		logger.info(`Standalone ${kind} preflight passed.`)
		return null
	}

	const address = raw.address ? checksumAddress(raw.address) : recordedAddress(ethers, kind)
	await requireCode(ethers, address, RECORD_NAMES[kind])

	if (kind === "feeDistributor") {
		const contract = await ethers.getContractAt("SymmioFeeDistributor", address)
		requireEqualAddress(ethers, await contract.symmioAddress(), symmioAddress!, "FeeDistributor SYMMIO address")
		requireEqualAddress(ethers, await contract.symmioReceiver(), receiver!, "FeeDistributor receiver")
		if ((await contract.symmioShare()) !== share) throw new Error(`FeeDistributor share does not equal ${share}`)
		if (!(await contract.hasRole(await contract.DEFAULT_ADMIN_ROLE(), admin))) throw new Error(`FeeDistributor admin role is missing for ${admin}`)
		const stakeholder = await contract.stakeholders(0)
		requireEqualAddress(ethers, stakeholder.receiver, receiver!, "FeeDistributor first stakeholder")
		if (stakeholder.share !== share) throw new Error(`FeeDistributor first stakeholder share does not equal ${share}`)
		await requireProxyImplementation(ethers, address, "FeeDistributor proxy")
	} else if (kind === "multiAccount") {
		const contract = await ethers.getContractAt("MultiAccount", address)
		requireEqualAddress(ethers, await contract.symmioAddress(), symmioAddress!, "MultiAccount SYMMIO address")
		requireEqualAddress(ethers, await contract.accountsAdmin(), admin!, "MultiAccount accounts admin")
		for (const role of [
			await contract.DEFAULT_ADMIN_ROLE(),
			await contract.SETTER_ROLE(),
			await contract.PAUSER_ROLE(),
			await contract.UNPAUSER_ROLE(),
		]) {
			if (!(await contract.hasRole(role, admin))) throw new Error(`MultiAccount role ${role} is missing for ${admin}`)
		}
		const accountImplementation = await contract.accountImplementation()
		const partyAArtifact = await hre.artifacts.readArtifact("SymmioPartyA")
		if (ethers.keccak256(accountImplementation) !== ethers.keccak256(partyAArtifact.bytecode)) {
			throw new Error("MultiAccount PartyA implementation bytecode does not match the compiled SymmioPartyA artifact")
		}
		await requireProxyImplementation(ethers, address, "MultiAccount proxy")
	} else {
		const contract = await ethers.getContractAt("Multicall3", address)
		await contract.getBlockNumber()
	}

	logger.info(`Standalone ${kind} post-state verified at ${address}.`)
	return address
}

export const checkStandaloneDeploymentTask = task(
	"check:standalone-deployment",
	"Internal preflight and post-state verification for registered standalone deployment workflows",
)
	.addOption({ name: "kind", description: "Standalone deployment kind", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "phase", description: "preflight or poststate", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "address",
		description: "Explicit deployed address for tests",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({
		name: "symmioAddress",
		description: "Expected SYMMIO Core address",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "Expected administrator", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "symmioShareReceiver",
		description: "Expected SYMMIO share receiver",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "symmioShare", description: "Expected SYMMIO share", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.setAction(async () => ({
		default: async (args, hre) =>
			checkStandaloneDeployment(hre, {
				...args,
				kind: requireKind(requireArg(args.kind, "kind")),
				phase: requirePhase(requireArg(args.phase, "phase")),
			}),
	}))
	.build()
