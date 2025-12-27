import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE } from "./constants.js"
import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"

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

type DeployAccountHubArgs = {
	admin: string
	affiliatehubaddress: string
	logData?: boolean
}

export async function deployAccountHub(hre: any, { admin, affiliatehubaddress, logData = true }: DeployAccountHubArgs) {
	const { ethers, upgrades } = await getConnection(hre)
	console.log("Running deploy:accountHub")

	const [deployer] = await ethers.getSigners()
	console.log("Deploying contracts with the account:", deployer.address)

	// Deploy linked libraries
	const libQuoteParamsAddress = await deployLibQuoteParams(ethers)

	// Get AccountManager bytecode
	const accountManagerBytecode = await getAccountManagerBytecode(ethers)

	// Deploy AccountHub as upgradeable proxy
	const contract = await deployAccountHubContract(hre, admin, affiliatehubaddress, accountManagerBytecode, libQuoteParamsAddress)

	const addresses = {
		proxy: await contract.getAddress(),
		...(await getUpgradeAddresses(upgrades, contract)),
	}
	console.log("AccountHub deployed to", addresses)

	// Log deployment data if requested
	if (logData) {
		await logDeploymentData(addresses, admin, affiliatehubaddress, accountManagerBytecode)
	}

	// Return contract instance
	return contract
}

export const accountHubTask = task("deploy:accountHub", "Deploys the AccountHub")
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "affiliatehubaddress",
		description: "The address of the affiliateHub contract",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ admin, affiliatehubaddress, logData }, hre) => deployAccountHub(hre, { admin, affiliatehubaddress, logData }),
	}))
	.build()
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
async function deployAccountHubContract(
	hre: any,
	admin: string,
	affiliateHubAddress: string,
	accountManagerBytecode: string,
	libQuoteParamsAddress: string,
) {
	const { ethers } = await getConnection(hre)
	console.log(`Initializing ${CONTRACT_CONFIG.NAME} with:`, {
		admin,
		affiliateHubAddress,
		accountManagerBytecode: `${accountManagerBytecode.slice(0, 10)}...`,
	})

	const Factory = await ethers.getContractFactory(CONTRACT_CONFIG.NAME, {
		libraries: {
			"project/contracts/accountHub/libraries/LibQuoteParams.sol:LibQuoteParams": libQuoteParamsAddress,
		},
	})
	const contract = await deployProxyWithFallback(hre, Factory, [admin, affiliateHubAddress, accountManagerBytecode], {
		initializer: CONTRACT_CONFIG.INITIALIZER,
	})
	await contract.waitForDeployment()

	return contract
}

async function deployLibQuoteParams(ethers: any): Promise<string> {
	const LibQuoteParamsFactory = await ethers.getContractFactory("LibQuoteParams")
	const libQuoteParams = await LibQuoteParamsFactory.deploy()
	await libQuoteParams.waitForDeployment()
	return libQuoteParams.getAddress()
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
