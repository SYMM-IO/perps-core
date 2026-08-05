import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { INSTANTLAYER_DEPLOYMENT_FILE } from "./constants.js"
import { getConnection, requireArg } from "./helpers.js"
import { logger } from "./logger.js"

// Contract configuration
const CONTRACT_CONFIG = {
	NAME: "InstantLayer",
} as const

// Deployment entry types
const ENTRY_TYPES = {
	CONTRACT: "Contract",
} as const

type DeployInstantLayerArgs = {
	symmioaddress: string
	admin: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deployInstantLayer(hre: any, { symmioaddress, admin, logData = true, checkpoint }: DeployInstantLayerArgs) {
	const { ethers } = await getConnection(hre)

	logger.section("InstantLayer Deployment")

	const [deployer] = await ethers.getSigners()
	logger.debug("Deployer:", deployer.address)

	// Check if already deployed from checkpoint
	if (checkpoint?.contracts.instantLayer) {
		const address = checkpoint.contracts.instantLayer.address
		logger.info(`  ⏭ InstantLayer already deployed at ${address}`)
		const instantLayer = await ethers.getContractAt("InstantLayer", address)
		return instantLayer
	}

	// Deploy InstantLayer
	logger.subsection("Contract")
	const instantLayer = await deployInstantLayerContract(symmioaddress, admin, ethers, deployer)

	const address = await instantLayer.getAddress()
	logger.deployed("InstantLayer", address)

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.instantLayer = createDeployedContract(address, [symmioaddress, admin])
		saveCheckpoint(checkpoint)
	}

	logger.complete("InstantLayer Deployment", [{ name: "InstantLayer", address }])

	// Log deployment data if requested
	if (logData) {
		await logDeploymentData(address, symmioaddress, admin)
	}

	return instantLayer
}

export const instantLayerTask = task("deploy:InstantLayer", "Deploys the InstantLayer contract")
	.addOption({
		name: "symmioaddress",
		description: "The address of the Symmio contract",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ symmioaddress, admin, logData }, hre) =>
			deployInstantLayer(hre, { symmioaddress: requireArg(symmioaddress, "symmioaddress"), admin: requireArg(admin, "admin"), logData }),
	}))
	.build()
/**
 * Deploys the InstantLayer contract
 */
async function deployInstantLayerContract(symmioAddress: string, admin: string, ethers: any, deployer: any) {
	const InstantLayerFactory = await ethers.getContractFactory("InstantLayer")
	const instantLayer = await InstantLayerFactory.connect(deployer).deploy(symmioAddress, admin)
	await instantLayer.waitForDeployment()
	await instantLayer.deploymentTransaction()!.wait()

	return instantLayer
}

/**
 * Logs deployment data to the deployment log file
 */
async function logDeploymentData(address: string, symmioAddress: string, admin: string): Promise<void> {
	try {
		const newEntry = createDeploymentEntry(address, symmioAddress, admin)
		writeData(INSTANTLAYER_DEPLOYMENT_FILE, [newEntry])
	} catch (err) {
		logger.error(`Failed to log deployment data: ${err}`)
		throw err
	}
}

/**
 * Creates deployment log entry for the InstantLayer contract
 */
function createDeploymentEntry(address: string, symmioAddress: string, admin: string): any {
	return {
		name: "InstantLayer",
		address: address,
		constructorArguments: [symmioAddress, admin],
	}
}
