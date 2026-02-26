import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"
import { logger } from "./logger.js"

type DeploySignatureVerifierArgs = {
	admin?: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deploySignatureVerifier(hre: any, { admin, logData = true, checkpoint }: DeploySignatureVerifierArgs = {}) {
	const { ethers } = await getConnection(hre)
	logger.section("MuonSignatureVerifier Deployment")

	const [deployer] = await ethers.getSigners()
	const resolvedAdmin = admin || deployer.address
	logger.debug("Deploying MuonSignatureVerifier with account:", deployer.address)
	logger.debug("SignatureVerifier admin:", resolvedAdmin)

	// Check if already deployed from checkpoint
	if (checkpoint?.contracts.signatureVerifier) {
		const address = checkpoint.contracts.signatureVerifier.address
		logger.info(`  ⏭ MuonSignatureVerifier already deployed at ${address}`)
		return ethers.getContractAt("MuonSignatureVerifier", address)
	}

	const factory = await ethers.getContractFactory("MuonSignatureVerifier")
	const contract = await factory.connect(deployer).deploy(resolvedAdmin)
	await contract.waitForDeployment()
	await contract.deploymentTransaction()!.wait()

	const address = await contract.getAddress()
	logger.deployed("MuonSignatureVerifier", address)

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.signatureVerifier = createDeployedContract(address, [resolvedAdmin])
		saveCheckpoint(checkpoint)
	}

	if (logData) {
		let deployedData = []
		try {
			deployedData = readData(DEPLOYMENT_LOG_FILE)
		} catch (err) {
			logger.debug(`Could not read existing JSON file: ${err}`)
		}

		deployedData.push({
			name: "MuonSignatureVerifier",
			address,
			constructorArguments: [resolvedAdmin],
		})

		writeData(DEPLOYMENT_LOG_FILE, deployedData)
		logger.debug("Deployed addresses written to JSON file")
	}

	return contract
}

export const signatureVerifierTask = task("deploy:signatureVerifier", "Deploys the MuonSignatureVerifier")
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ admin, logData }, hre) => deploySignatureVerifier(hre, { admin, logData }),
	}))
	.build()
