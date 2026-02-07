import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"
import { logger } from "./logger.js"

export const multiaccountTask = task("deploy:multiAccount", "Deploys the MultiAccount")
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
			const { ethers, upgrades } = await getConnection(hre)
			logger.section("MultiAccount Deployment")

			const [deployer] = await ethers.getSigners()

			logger.debug("Deploying contracts with the account:", deployer.address)

			const SymmioPartyA = await ethers.getContractFactory("SymmioPartyA")

			// Deploy MultiAccount as upgradeable
			const Factory = await ethers.getContractFactory("MultiAccount")
			logger.debug("Admin:", admin, "Symmio:", symmioAddress)
			const contract = await deployProxyWithFallback(hre, Factory, [admin, symmioAddress, SymmioPartyA.bytecode], { initializer: "initialize" })
			await contract.waitForDeployment()

			const addresses = {
				proxy: await contract.getAddress(),
				...(await getUpgradeAddresses(upgrades, contract)),
			}
			logger.deployed("MultiAccount (Proxy)", addresses.proxy)
			if (addresses.implementation) {
				logger.deployed("MultiAccount (Implementation)", addresses.implementation)
			}
			if (addresses.admin) {
				logger.deployed("MultiAccount (Admin)", addresses.admin)
			}

			if (logData) {
				// Read existing data
				let deployedData = []
				try {
					deployedData = readData(DEPLOYMENT_LOG_FILE)
				} catch (err) {
					logger.debug(`Could not read existing JSON file: ${err}`)
				}

				// Append new data
				deployedData.push(
					{
						name: "MultiAccountProxy",
						address: await contract.getAddress(),
						constructorArguments: [admin, symmioAddress, SymmioPartyA.bytecode],
					},
					{
						name: "MultiAccountAdmin",
						address: addresses.admin,
						constructorArguments: [],
					},
					{
						name: "MultiAccountImplementation",
						address: addresses.implementation,
						constructorArguments: [],
					},
				)

				// Write updated data back to JSON file
				writeData(DEPLOYMENT_LOG_FILE, deployedData)
				logger.debug("Deployed addresses written to JSON file")
			}

			return contract
		},
	}))
	.build()
