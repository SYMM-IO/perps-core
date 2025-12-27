import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"

type DeployStablecoinArgs = {
	logData?: boolean
}

export async function deployStablecoin(hre: any, { logData = true }: DeployStablecoinArgs = {}) {
	const { ethers } = await getConnection(hre)

	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]

	const StablecoinFactory = await ethers.getContractFactory("FakeStablecoin")
	const stablecoin = await StablecoinFactory.connect(owner).deploy()
	await stablecoin.waitForDeployment()

	await stablecoin.deploymentTransaction()!.wait()
	logger.debug("FakeStablecoin deployed:", await stablecoin.getAddress())

	if (logData) {
		// Read existing data
		let deployedData = []
		try {
			deployedData = readData(DEPLOYMENT_LOG_FILE)
		} catch (err) {}

		// Append new data
		deployedData.push({
			name: "FakeStablecoin",
			address: await stablecoin.getAddress(),
			constructorArguments: [],
		})

		// Write updated data back to JSON file
		writeData(DEPLOYMENT_LOG_FILE, deployedData)
	}

	return stablecoin
}

export const stablecoinTask = task("deploy:stablecoin", "Deploys the FakeStablecoin")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => deployStablecoin(hre, { logData }),
	}))
	.build()
