import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { STABLECOIN_DEPLOYMENT_FILE } from "./constants.js"
import { checkpointDeployment, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeployment } from "./tx.js"

type DeployStablecoinArgs = {
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deployStablecoin(hre: any, { logData = true, checkpoint }: DeployStablecoinArgs = {}) {
	const { ethers } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.collateral")

	// Check if already deployed from checkpoint
	if (checkpoint?.contracts.collateral) {
		const address = checkpoint.contracts.collateral.address
		logger.info(`  ⏭ FakeStablecoin already deployed at ${address}`)
		if (logData) writeStablecoinRecord(address)
		const stablecoin = await ethers.getContractAt("FakeStablecoin", address)
		return stablecoin
	}

	const signers: HardhatEthersSigner[] = await ethers.getSigners()
	const owner: HardhatEthersSigner = signers[0]

	const StablecoinFactory = await ethers.getContractFactory("FakeStablecoin")
	const stablecoin = await StablecoinFactory.connect(owner).deploy()
	const address = await confirmDeployment(stablecoin, "FakeStablecoin", checkpointDeployment(checkpoint, "contracts.collateral"))
	logger.deployed("FakeStablecoin", address)

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.collateral = createDeployedContract(address)
		saveCheckpoint(checkpoint)
	}

	if (logData) {
		writeStablecoinRecord(address)
	}

	return stablecoin
}

function writeStablecoinRecord(address: string): void {
	writeData(STABLECOIN_DEPLOYMENT_FILE, [{ name: "FakeStablecoin", address, constructorArguments: [] }])
}

export const stablecoinTask = task("deploy:stablecoin", "Deploys the FakeStablecoin")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:stablecoin")
			return deployStablecoin(hre, { logData })
		},
	}))
	.build()
