import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"
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
}

export async function deployInstantLayer(hre: any, { symmioaddress, admin, logData = true }: DeployInstantLayerArgs) {
	const { ethers } = await getConnection(hre)

	logger.section("InstantLayer Deployment")

	const [deployer] = await ethers.getSigners()
	logger.debug("Deployer:", deployer.address)

	// Deploy InstantLayer
	logger.subsection("Contract")
	const instantLayer = await deployInstantLayerContract(symmioaddress, admin, ethers, deployer)

	const address = await instantLayer.getAddress()

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
		default: async ({ symmioaddress, admin, logData }, hre) => deployInstantLayer(hre, { symmioaddress, admin, logData }),
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
	logger.deployed("InstantLayer", await instantLayer.getAddress())

	return instantLayer
}

/**
 * Logs deployment data to the deployment log file
 */
async function logDeploymentData(address: string, symmioAddress: string, admin: string): Promise<void> {
	try {
		const deployedData = readExistingDeployments()
		const newEntry = createDeploymentEntry(address, symmioAddress, admin)
		const updatedData = [...deployedData, newEntry]

		writeData(ACCOUNTHUB_DEPLOYMENT_LOG_FILE, updatedData)
	} catch (err) {
		logger.error(`Failed to log deployment data: ${err}`)
		throw err
	}
}

/**
 * Reads existing deployment data from file
 */
function readExistingDeployments(): any[] {
	try {
		return readData(ACCOUNTHUB_DEPLOYMENT_LOG_FILE)
	} catch (err) {
		return []
	}
}

/**
 * Creates deployment log entry for the InstantLayer contract
 */
function createDeploymentEntry(address: string, symmioAddress: string, admin: string): any {
	return {
		name: `${CONTRACT_CONFIG.NAME}${ENTRY_TYPES.CONTRACT}`,
		address: address,
		constructorArguments: [symmioAddress, admin],
	}
}
