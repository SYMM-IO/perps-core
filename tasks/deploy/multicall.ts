import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"

export const multicallTask = task("deploy:multicall", "Deploys the Multicall")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			const { ethers } = await getConnection(hre)
			console.log("Running deploy:multicall")

			const signers: HardhatEthersSigner[] = await ethers.getSigners()
			const owner: HardhatEthersSigner = signers[0]

			const Factory = await ethers.getContractFactory("Multicall3")
			const multicall = await Factory.connect(owner).deploy()
			await multicall.waitForDeployment()

			await multicall.deploymentTransaction()!.wait()
			console.log("Multicall3 deployed:", await multicall.getAddress())

			if (logData) {
				// Read existing data
				let deployedData = []
				try {
					deployedData = readData(DEPLOYMENT_LOG_FILE)
				} catch (err) {
					console.error(`Could not read existing JSON file: ${err}`)
				}

				// Append new data
				deployedData.push({
					name: "Multicall3",
					address: await multicall.getAddress(),
					constructorArguments: [],
				})

				// Write updated data back to JSON file
				writeData(DEPLOYMENT_LOG_FILE, deployedData)
				console.log("Deployed addresses written to JSON file")
			}

			return multicall
		},
	}))
	.build()
