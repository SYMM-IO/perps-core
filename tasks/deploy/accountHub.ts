import { task, types } from "hardhat/config"
import { readData, writeData } from "../utils/fs"
import { DEPLOYMENT_LOG_FILE } from "./constants"

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

task("deploy:accountHub", "Deploys the AccountHub")
	.addParam("admin", "The admin address")
	.addParam("affiliateHubAddress", "The address of the affiliateHub contract")
	.addOptionalParam("logData", "Write the deployed addresses to a data file", true, types.boolean)
	.setAction(async ({ admin, affiliateHubAddress, logData }, { ethers, upgrades }) => {
		console.log("Running deploy:accountHub")

		const [deployer] = await ethers.getSigners()
		console.log("Deploying contracts with the account:", deployer.address)

		// Get AccountManager bytecode
		const accountManagerBytecode = await getAccountManagerBytecode(ethers)

		// Deploy AccountHub as upgradeable proxy
		const contract = await deployAccountHub(admin, affiliateHubAddress, accountManagerBytecode, ethers, upgrades)

		const addresses = {
			proxy: await contract.getAddress(),
			admin: await upgrades.erc1967.getAdminAddress(await contract.getAddress()),
			implementation: await upgrades.erc1967.getImplementationAddress(await contract.getAddress()),
		}
		console.log("AccountHub deployed to", addresses)

		// Log deployment data if requested
		if (logData) {
			await logDeploymentData(addresses, admin, affiliateHubAddress, accountManagerBytecode)
		}

		// Return contract instance
		return contract
	})

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
async function deployAccountHub(admin: string, affiliateHubAddress: string, accountManagerBytecode: string, ethers: any, upgrades: any) {
	console.log(`Initializing ${CONTRACT_CONFIG.NAME} with:`, {
		admin,
		affiliateHubAddress,
		accountManagerBytecode: `${accountManagerBytecode.slice(0, 10)}...`,
	})

	const Factory = await ethers.getContractFactory(CONTRACT_CONFIG.NAME)
	const contract = await upgrades.deployProxy(Factory, [admin, affiliateHubAddress, accountManagerBytecode], {
		initializer: CONTRACT_CONFIG.INITIALIZER,
	})
	await contract.waitForDeployment()

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

		writeData(DEPLOYMENT_LOG_FILE, updatedData)
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
		return readData(DEPLOYMENT_LOG_FILE)
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
		{
			name: `${CONTRACT_CONFIG.NAME}${ENTRY_TYPES.ADMIN}`,
			address: addresses.admin,
			constructorArguments: [],
		},
		{
			name: `${CONTRACT_CONFIG.NAME}${ENTRY_TYPES.IMPLEMENTATION}`,
			address: addresses.implementation,
			constructorArguments: [],
		},
	]
}
