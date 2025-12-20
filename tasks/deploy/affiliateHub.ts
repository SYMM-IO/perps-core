import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE } from "./constants"
import { deployProxy, erc1967 } from "../../utils/upgrades-shim"

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

export async function deployAffiliateHub(
	hre: HardhatRuntimeEnvironment,
	{
		admin = "",
		symmiofeereceiver = "",
		logData = true,
	}: { admin?: string; symmiofeereceiver?: string; logData?: boolean } = {},
) {
	const { ethers } = hre
	console.log("Running deploy:affiliateHub")

	const [deployer] = await ethers.getSigners()
	console.log("Deploying contracts with the account:", deployer.address)

	// Deploy AffiliateHub as upgradeable proxy
	const contract = await deployAffiliateHubProxy(hre, admin, symmiofeereceiver)

	const addresses = {
		proxy: await contract.getAddress(),
		admin: await erc1967(hre).getAdminAddress(await contract.getAddress()),
		implementation: await erc1967(hre).getImplementationAddress(await contract.getAddress()),
	}
	console.log("AffiliateHub deployed to", addresses)

	// Log deployment data if requested
	if (logData) {
		await logDeploymentData(addresses, admin, symmiofeereceiver)
	}

	// Return contract instance
	return contract
}

task("deploy:affiliateHub", "Deploys the AffiliateHub")
	.addOption({ name: "admin", description: "The admin address", defaultValue: "" })
	.addOption({ name: "symmiofeereceiver", description: "The address of the symmio fee receiver", defaultValue: "" })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async (taskArgs, hre) => deployAffiliateHub(hre, taskArgs))

/**
 * Deploys the AffiliateHub upgradeable contract
 */
async function deployAffiliateHubProxy(hre: any, admin: string, symmioFeeReceiver: string) {
	console.log(`Initializing ${CONTRACT_CONFIG.NAME} with:`, {
		admin,
		symmioFeeReceiver,
	})

	const Factory = await hre.ethers.getContractFactory("AffiliateHub")
	const contract = await deployProxy(hre, Factory, [admin, symmioFeeReceiver], {
		initializer: CONTRACT_CONFIG.INITIALIZER,
		admin,
	})

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
