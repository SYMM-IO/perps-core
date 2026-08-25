import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { PARTYB_DEPLOYMENT_FILE } from "./constants.js"
import { recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import {
	assertStandaloneDeploymentTaskAllowed,
	checksumAddress,
	deployProxyWithFallback,
	getConnection,
	getUpgradeAddresses,
	requireArg,
} from "./helpers.js"
import { logger } from "./logger.js"
import type { VanityContext } from "./vanityDeploy.js"

type DeploySymmioPartyBArgs = {
	symmioAddress: string
	admin: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
	/** Present when the owning deployment mines CREATE2 addresses; null for standalone runs. */
	vanity?: VanityContext | null
}

const SYMMIO_PARTYB_FQN = "contracts/helpers/accounts/SymmioPartyB.sol:SymmioPartyB"
const LOCAL_ERC1967_PROXY_FQN = "contracts/helpers/utils/LocalERC1967Proxy.sol:LocalERC1967Proxy"

export type SymmioPartyBVerificationRecord = {
	name: string
	address: string
	constructorArguments: unknown[]
}

/**
 * Build the exact explorer-verification payload for the fallback UUPS deployment.
 *
 * SymmioPartyB's admin and Symmio addresses are initializer arguments, not proxy
 * constructor arguments. The deployed proxy is LocalERC1967Proxy, whose constructor
 * receives the implementation address and ABI-encoded initializer calldata.
 */
export function createSymmioPartyBVerificationRecords(
	factory: { interface: { encodeFunctionData: (name: string, args: readonly unknown[]) => string } },
	addresses: { proxy: string; implementation?: string },
	initializerArgs: readonly [string, string],
): SymmioPartyBVerificationRecord[] {
	if (!addresses.implementation) {
		throw new Error("Cannot create SymmioPartyB verification records: ERC1967 implementation address is unavailable")
	}

	const initData = factory.interface.encodeFunctionData("initialize", initializerArgs)
	return [
		{
			name: SYMMIO_PARTYB_FQN,
			address: addresses.implementation,
			constructorArguments: [],
		},
		{
			name: LOCAL_ERC1967_PROXY_FQN,
			address: addresses.proxy,
			constructorArguments: [addresses.implementation, initData],
		},
	]
}

export async function deploySymmioPartyB(
	hre: any,
	{ symmioAddress: rawSymmio, admin: rawAdmin, logData = true, checkpoint, vanity }: DeploySymmioPartyBArgs,
) {
	const { ethers, upgrades } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.symmioPartyB")

	const admin = checksumAddress(rawAdmin)
	const symmioAddress = checksumAddress(rawSymmio)

	const [deployer] = await ethers.getSigners()
	logger.debug("Deploying SymmioPartyB with account:", deployer.address)
	const initializerArgs: [string, string] = [admin, symmioAddress]
	const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")

	let symmioPartyB: any
	if (checkpoint?.contracts.symmioPartyB) {
		const address = checkpoint.contracts.symmioPartyB.address
		logger.reused("SymmioPartyB", address)
		symmioPartyB = await ethers.getContractAt("SymmioPartyB", address)
	} else {
		// Deploy SymmioPartyB as upgradeable. This repository does not install the
		// OpenZeppelin upgrades plugin, so deployProxyWithFallback deploys the
		// implementation followed by LocalERC1967Proxy(implementation, initData).
		symmioPartyB = await deployProxyWithFallback(hre, SymmioPartyBFactory, initializerArgs, {
			initializer: "initialize",
			label: "SymmioPartyB",
			vanity: vanity || null,
			proxyKey: "peripherals/SymmioPartyB",
			checkpoint,
			implementationComponent: "deployments.symmioPartyB.implementation",
			proxyComponent: "contracts.symmioPartyB",
		})
	}

	const addresses = {
		proxy: await symmioPartyB.getAddress(),
		...(await getUpgradeAddresses(upgrades, symmioPartyB)),
	}
	if (!addresses.implementation) {
		throw new Error(`SymmioPartyB proxy ${addresses.proxy} has no ERC1967 implementation address`)
	}
	const implementationCode = await ethers.provider.getCode(addresses.implementation)
	if (!implementationCode || implementationCode === "0x") {
		throw new Error(`SymmioPartyB implementation ${addresses.implementation} has no deployed code`)
	}
	if (
		checkpoint?.contracts.symmioPartyB?.implementation &&
		checksumAddress(checkpoint.contracts.symmioPartyB.implementation) !== checksumAddress(addresses.implementation)
	) {
		throw new Error(
			`SymmioPartyB checkpoint implementation ${checkpoint.contracts.symmioPartyB.implementation} does not match proxy storage ${addresses.implementation}`,
		)
	}
	const verificationRecords = createSymmioPartyBVerificationRecords(SymmioPartyBFactory, addresses, initializerArgs)
	logger.deployed("SymmioPartyB (Proxy)", addresses.proxy)
	logger.deployed("SymmioPartyB (Implementation)", addresses.implementation)
	if (addresses.admin) {
		logger.deployed("SymmioPartyB (Admin)", addresses.admin)
	}

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.symmioPartyB = {
			...createDeployedContract(addresses.proxy, verificationRecords[1].constructorArguments),
			implementation: addresses.implementation,
			admin: addresses.admin,
		}
		saveCheckpoint(checkpoint)
	}

	// Write deployment data to JSON file
	if (logData) {
		// Replace the scoped PartyB file with exactly one implementation/proxy pair.
		// This also repairs a missing/stale log when resuming after the checkpoint was
		// persisted but before the verification records were written.
		writeData(PARTYB_DEPLOYMENT_FILE, verificationRecords)
	}

	return symmioPartyB
}

export const partyBTask = task("deploy:symmioPartyB", "Deploys the SymmioPartyB")
	.addOption({
		name: "symmioAddress",
		description: "The address of the Symmio contract",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ symmioAddress, admin, logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:symmioPartyB")
			return deploySymmioPartyB(hre, {
				symmioAddress: requireArg(symmioAddress, "symmio-address"),
				admin: requireArg(admin, "admin"),
				logData,
			})
		},
	}))
	.build()
