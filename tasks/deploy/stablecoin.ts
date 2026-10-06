import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { STABLECOIN_DEPLOYMENT_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"

type DeployStablecoinArgs = {
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deployStablecoin(hre: any, { logData = true, checkpoint }: DeployStablecoinArgs = {}) {
	const { ethers } = await getConnection(hre)

	// Check if already deployed from checkpoint
	if (checkpoint?.contracts.collateral) {
		const address = checkpoint.contracts.collateral.address
		logger.info(`  ⏭ FakeStablecoin already deployed at ${address}`)
		const stablecoin = await ethers.getContractAt("FakeStablecoin", address)
		return stablecoin
	}

	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]

	const StablecoinFactory = await ethers.getContractFactory("FakeStablecoin")
	const stablecoin = await StablecoinFactory.connect(owner).deploy()
	await stablecoin.waitForDeployment()

	await stablecoin.deploymentTransaction()!.wait()
	const address = await stablecoin.getAddress()
	logger.deployed("FakeStablecoin", address)

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.collateral = createDeployedContract(address)
		saveCheckpoint(checkpoint)
	}

	if (logData) {
		writeData(STABLECOIN_DEPLOYMENT_FILE, [
			{
				name: "FakeStablecoin",
				address,
				constructorArguments: [],
			},
		])
	}

	return stablecoin
}

export const stablecoinTask = task("deploy:stablecoin", "Deploys the FakeStablecoin")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => deployStablecoin(hre, { logData }),
	}))
	.build()
