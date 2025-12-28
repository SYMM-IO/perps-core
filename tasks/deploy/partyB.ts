import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"
import { logger } from "./logger.js"

type DeploySymmioPartyBArgs = {
	symmioAddress: string
	admin: string
	logData?: boolean
}

export async function deploySymmioPartyB(hre: any, { symmioAddress, admin, logData = true }: DeploySymmioPartyBArgs) {
	const { ethers, upgrades } = await getConnection(hre)

	const [deployer] = await ethers.getSigners()
	logger.debug("Deploying SymmioPartyB with account:", deployer.address)

	// Deploy SymmioPartyB as upgradeable
	const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
	const symmioPartyB = await deployProxyWithFallback(hre, SymmioPartyBFactory, [admin, symmioAddress], { initializer: "initialize" })
	await symmioPartyB.waitForDeployment()

	const addresses = {
		proxy: await symmioPartyB.getAddress(),
		...(await getUpgradeAddresses(upgrades, symmioPartyB)),
	}
	logger.debug("SymmioPartyB deployed to", addresses.proxy)

	// Update the deployed addresses JSON file
	if (logData) {
		let deployedData = []
		try {
			deployedData = readData(DEPLOYMENT_LOG_FILE)
		} catch (err) {
			logger.debug(`Could not read existing JSON file: ${err}`)
		}

		// Append new data
		deployedData.push(
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
		)

		// Write updated data back to JSON file
		writeData(DEPLOYMENT_LOG_FILE, deployedData)
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
