import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { PARTYB_DEPLOYMENT_FILE } from "./constants.js"
import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"
import { logger } from "./logger.js"
import {
	DeploymentCheckpoint,
	createDeployedContract,
	saveCheckpoint,
} from "./checkpoint.js"

type DeploySymmioPartyBArgs = {
	symmioAddress: string
	admin: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deploySymmioPartyB(hre: any, { symmioAddress, admin, logData = true, checkpoint }: DeploySymmioPartyBArgs) {
	const { ethers, upgrades } = await getConnection(hre)

	const [deployer] = await ethers.getSigners()
	logger.debug("Deploying SymmioPartyB with account:", deployer.address)

	// Check if already deployed from checkpoint
	if (checkpoint?.contracts.symmioPartyB) {
		const address = checkpoint.contracts.symmioPartyB.address
		logger.info(`  ⏭ SymmioPartyB already deployed at ${address}`)
		const symmioPartyB = await ethers.getContractAt("SymmioPartyB", address)
		return symmioPartyB
	}

	// Deploy SymmioPartyB as upgradeable
	const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
	const symmioPartyB = await deployProxyWithFallback(hre, SymmioPartyBFactory, [admin, symmioAddress], { initializer: "initialize" })
	await symmioPartyB.waitForDeployment()

	const addresses = {
		proxy: await symmioPartyB.getAddress(),
		...(await getUpgradeAddresses(upgrades, symmioPartyB)),
	}
	logger.deployed("SymmioPartyB (Proxy)", addresses.proxy)
	if (addresses.implementation) {
		logger.deployed("SymmioPartyB (Implementation)", addresses.implementation)
	}
	if (addresses.admin) {
		logger.deployed("SymmioPartyB (Admin)", addresses.admin)
	}

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.symmioPartyB = {
			...createDeployedContract(addresses.proxy, [admin, symmioAddress]),
			implementation: addresses.implementation,
			admin: addresses.admin,
		}
		saveCheckpoint(checkpoint)
	}

	// Write deployment data to JSON file
	if (logData) {
		writeData(PARTYB_DEPLOYMENT_FILE, [
			{
				name: "SymmioPartyBProxy",
				address: await symmioPartyB.getAddress(),
				constructorArguments: [admin, symmioAddress],
			},
			{
				name: "SymmioPartyBAdmin",
				address: addresses.admin,
				constructorArguments: [],
			},
			{
				name: "SymmioPartyBImplementation",
				address: addresses.implementation,
				constructorArguments: [],
			},
		])
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
		default: async ({ symmioAddress, admin, logData }, hre) => deploySymmioPartyB(hre, { symmioAddress, admin, logData }),
	}))
	.build()
