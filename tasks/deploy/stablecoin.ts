import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { ArgumentType } from "hardhat/types/arguments"
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers"
import { readData, writeData } from "../utils/fs"
import { DEPLOYMENT_LOG_FILE } from "./constants"

export async function deployStablecoin(
	hre: HardhatRuntimeEnvironment,
	{ logData = true }: { logData?: boolean } = {},
) {
	const { ethers } = hre
	console.log("Running deploy:stablecoin")

	const signers: SignerWithAddress[] = await ethers.getSigners()
	const owner: SignerWithAddress = signers[0]
	console.log("using address: " + JSON.stringify(owner))

	const StablecoinFactory = await ethers.getContractFactory("FakeStablecoin")
	const stablecoin = await StablecoinFactory.connect(owner).deploy()
	await stablecoin.waitForDeployment()

	await stablecoin.deploymentTransaction()!.wait()
	console.log("FakeStablecoin deployed:", await stablecoin.getAddress())

	if (logData) {
		// Read existing data
		let deployedData = []
		try {
			deployedData = readData(DEPLOYMENT_LOG_FILE)
		} catch (err) {
		}

		// Append new data
		deployedData.push({
			name: "FakeStablecoin",
			address: await stablecoin.getAddress(),
			constructorArguments: [],
		})

		// Write updated data back to JSON file
		writeData(DEPLOYMENT_LOG_FILE, deployedData)
		console.log("Deployed addresses written to JSON file")
	}

	return stablecoin
}

task("deploy:stablecoin", "Deploys the FakeStablecoin")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async (taskArgs, hre) => deployStablecoin(hre, taskArgs))
