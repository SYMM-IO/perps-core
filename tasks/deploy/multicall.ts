import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readDataIfExists, writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeployment } from "./tx.js"

export const multicallTask = task("deploy:multicall", "Deploys the Multicall")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:multicall")
			const { ethers } = await getConnection(hre)
			logger.section("Multicall3 Deployment")

			const signers: HardhatEthersSigner[] = await ethers.getSigners()
			const owner: HardhatEthersSigner = signers[0]

			const Factory = await ethers.getContractFactory("Multicall3")
			const multicall = await Factory.connect(owner).deploy()
			const address = await confirmDeployment(multicall, "Multicall3")
			logger.deployed("Multicall3", address)

			if (logData) {
				// Read existing data
				const deployedData: any[] = readDataIfExists(DEPLOYMENT_LOG_FILE) || []

				// Append new data
				deployedData.push({
					name: "Multicall3",
					address,
					constructorArguments: [],
				})

				// Write updated data back to JSON file
				writeData(DEPLOYMENT_LOG_FILE, deployedData)
				logger.debug("Deployed addresses written to JSON file")
			}

			return multicall
		},
	}))
	.build()
