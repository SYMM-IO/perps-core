import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE } from "./constants.js"
import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"

// Contract configuration
const CONTRACT_CONFIG = {
	NAME: "AffiliateHub",
	INITIALIZER: "initialize",
} as const

// Deployment entry types
const ENTRY_TYPES = {
	PROXY: "Proxy",
	ADMIN: "Admin",
	IMPLEMENTATION: "Implementation",
} as const

type DeployAffiliateHubArgs = {
	admin: string
	symmiofeereceiver: string
	logData?: boolean
}

export async function deployAffiliateHub(hre: any, { admin, symmiofeereceiver, logData = true }: DeployAffiliateHubArgs) {
	const { ethers, upgrades } = await getConnection(hre)
	console.log("Running deploy:affiliateHub")

	const [deployer] = await ethers.getSigners()
	console.log("Deploying contracts with the account:", deployer.address)

	// Deploy AffiliateHub as upgradeable proxy
	const contract = await deployAffiliateHubContract(hre, admin, symmiofeereceiver)

	const addresses = {
		proxy: await contract.getAddress(),
		...(await getUpgradeAddresses(upgrades, contract)),
	}
	console.log("AffiliateHub deployed to", addresses)

	// Log deployment data if requested
	if (logData) {
		await logDeploymentData(addresses, admin, symmiofeereceiver)
	}

	// Return contract instance
	return contract
}

export const affiliateHubTask = task("deploy:affiliateHub", "Deploys the AffiliateHub")
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "symmiofeereceiver",
		description: "The address of the symmio fee receiver",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ admin, symmiofeereceiver, logData }, hre) => deployAffiliateHub(hre, { admin, symmiofeereceiver, logData }),
	}))
	.build()
/**
 * Deploys the AffiliateHub upgradeable contract
 */
async function deployAffiliateHubContract(hre: any, admin: string, symmioFeeReceiver: string) {
	const { ethers } = await getConnection(hre)
	console.log(`Initializing ${CONTRACT_CONFIG.NAME} with:`, {
		admin,
		symmioFeeReceiver,
	})

	const Factory = await ethers.getContractFactory("AffiliateHub")
	const contract = await deployProxyWithFallback(hre, Factory, [admin, symmioFeeReceiver], {
		initializer: CONTRACT_CONFIG.INITIALIZER,
	})
	await contract.waitForDeployment()

	return contract
}

/**
 * Logs deployment data to the deployment log file
 */
async function logDeploymentData(addresses: any, admin: string, symmioFeeReceiver: string): Promise<void> {
	try {
		const deployedData = readExistingDeployments()
		const newEntries = createDeploymentEntries(addresses, admin, symmioFeeReceiver)
		const updatedData = [...deployedData, ...newEntries]

		writeData(ACCOUNTHUB_DEPLOYMENT_LOG_FILE, updatedData)
		console.log("Deployed addresses written to JSON file")
	} catch (err) {
		console.error(`Failed to log deployment data: ${err}`)
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
		console.warn(`Could not read existing JSON file: ${err}. Starting with empty data.`)
		return []
	}
}

/**
 * Creates deployment log entries for all deployed contracts
 */
function createDeploymentEntries(addresses: any, admin: string, symmioFeeReceiver: string): any[] {
	return [
		{
			name: `${CONTRACT_CONFIG.NAME}${ENTRY_TYPES.PROXY}`,
			address: addresses.proxy,
			constructorArguments: [admin, symmioFeeReceiver],
		},
	]
}
