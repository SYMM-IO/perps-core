import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE } from "./constants"
import { deployProxy, erc1967 } from "../../utils/upgrades-shim"

// Contract configuration
const CONTRACT_CONFIG = {
	NAME: "AccountHub",
	ACCOUNT_MANAGER_NAME: "AccountManager",
	INITIALIZER: "initialize",
} as const

// Deployment entry types
const ENTRY_TYPES = {
	PROXY: "Proxy",
	ADMIN: "Admin",
	IMPLEMENTATION: "Implementation",
} as const

export async function deployAccountHub(
	hre: HardhatRuntimeEnvironment,
	{
		admin = "",
		affiliatehubaddress = "",
		logData = true,
	}: { admin?: string; affiliatehubaddress?: string; logData?: boolean } = {},
) {
	const { ethers } = hre
	console.log("Running deploy:accountHub")

	const [deployer] = await ethers.getSigners()
	console.log("Deploying contracts with the account:", deployer.address)

	// Get AccountManager bytecode
	const accountManagerBytecode = await getAccountManagerBytecode(ethers)

	// Deploy AccountHub as upgradeable proxy
	const contract = await deployAccountHubProxy(hre, admin, affiliatehubaddress, accountManagerBytecode)

	const addresses = {
		proxy: await contract.getAddress(),
		admin: await erc1967(hre).getAdminAddress(await contract.getAddress()),
		implementation: await erc1967(hre).getImplementationAddress(await contract.getAddress()),
	}
	console.log("AccountHub deployed to", addresses)

	// Log deployment data if requested
	if (logData) {
		await logDeploymentData(addresses, admin, affiliatehubaddress, accountManagerBytecode)
	}

	// Return contract instance
	return contract
}

task("deploy:accountHub", "Deploys the AccountHub")
	.addOption({ name: "admin", description: "The admin address", defaultValue: "" })
	.addOption({ name: "affiliatehubaddress", description: "The address of the affiliateHub contract", defaultValue: "" })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async (taskArgs, hre) => deployAccountHub(hre, taskArgs))

/**
 * Gets the AccountManager contract bytecode
 */
async function getAccountManagerBytecode(ethers: any): Promise<string> {
	const accountManager = await ethers.getContractFactory(CONTRACT_CONFIG.ACCOUNT_MANAGER_NAME)
	return accountManager.bytecode
}

/**
 * Deploys the AccountHub upgradeable contract
 */
async function deployAccountHubProxy(hre: any, admin: string, affiliateHubAddress: string, accountManagerBytecode: string) {
	console.log(`Initializing ${CONTRACT_CONFIG.NAME} with:`, {
		admin,
		affiliateHubAddress,
		accountManagerBytecode: `${accountManagerBytecode.slice(0, 10)}...`,
	})

	// Deploy LibQuoteParams library first
	const LibQuoteParamsFactory = await hre.ethers.getContractFactory("LibQuoteParams")
	const libQuoteParams = await LibQuoteParamsFactory.deploy()
	await libQuoteParams.waitForDeployment()
	console.log("LibQuoteParams deployed to:", await libQuoteParams.getAddress())

	// Deploy AccountHub with library linked
	const Factory = await hre.ethers.getContractFactory(CONTRACT_CONFIG.NAME, {
		libraries: {
			LibQuoteParams: await libQuoteParams.getAddress(),
		},
	})
	const contract = await deployProxy(hre, Factory, [admin, affiliateHubAddress, accountManagerBytecode], {
		initializer: CONTRACT_CONFIG.INITIALIZER,
		admin,
	})

	return contract
}

/**
 * Logs deployment data to the deployment log file
 */
async function logDeploymentData(addresses: any, admin: string, affiliateHubAddress: string, accountManagerBytecode: string): Promise<void> {
	try {
		const deployedData = readExistingDeployments()
		const newEntries = createDeploymentEntries(addresses, admin, affiliateHubAddress, accountManagerBytecode)
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
function createDeploymentEntries(addresses: any, admin: string, affiliateHubAddress: string, accountManagerBytecode: string): any[] {
	return [
		{
			name: `${CONTRACT_CONFIG.NAME}${ENTRY_TYPES.PROXY}`,
			address: addresses.proxy,
			constructorArguments: [admin, affiliateHubAddress, accountManagerBytecode],
		},
	]
}
