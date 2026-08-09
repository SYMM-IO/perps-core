import fs from "fs"
import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { atomicWriteFile, upsertDeploymentRecords } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { checkpointDeployment, recoverCheckpointContractDeployments } from "./deploymentRecovery.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeployment } from "./tx.js"
import { loadUpgradeConfigShared } from "./upgradeConfig.js"

const DEFAULT_UPGRADE_CONFIG_FILE = "./tasks/config/upgrade.json"

type DeploySignatureVerifierArgs = {
	admin?: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
	updateUpgradeConfig?: boolean
}

export async function deploySignatureVerifier(
	hre: any,
	{ admin, logData = true, checkpoint, updateUpgradeConfig = false }: DeploySignatureVerifierArgs = {},
) {
	const { ethers } = await getConnection(hre)
	await recoverCheckpointContractDeployments(checkpoint, ethers.provider, "contracts.signatureVerifier")
	logger.section("MuonSignatureVerifier Deployment")

	const [deployer] = await ethers.getSigners()
	const resolvedAdmin = admin || process.env.PROTOCOL_ADMIN || loadUpgradeConfigShared().protocolAdmin || deployer.address
	logger.debug("Deploying MuonSignatureVerifier with account:", deployer.address)
	logger.debug("SignatureVerifier admin:", resolvedAdmin)

	// Check if already deployed from checkpoint
	if (checkpoint?.contracts.signatureVerifier) {
		const address = checkpoint.contracts.signatureVerifier.address
		const constructorAdmin = String(checkpoint.contracts.signatureVerifier.constructorArgs?.[0] || resolvedAdmin)
		logger.info(`  ⏭ MuonSignatureVerifier already deployed at ${address}`)
		if (logData) writeSignatureVerifierRecord(address, constructorAdmin)
		if (updateUpgradeConfig) updateUpgradeConfigFile(address)
		return ethers.getContractAt("MuonSignatureVerifier", address)
	}

	const factory = await ethers.getContractFactory("MuonSignatureVerifier")
	const contract = await factory.connect(deployer).deploy(resolvedAdmin)
	const address = await confirmDeployment(
		contract,
		"MuonSignatureVerifier",
		checkpointDeployment(checkpoint, "contracts.signatureVerifier", [resolvedAdmin]),
	)
	logger.deployed("MuonSignatureVerifier", address)

	// Save checkpoint
	if (checkpoint) {
		checkpoint.contracts.signatureVerifier = createDeployedContract(address, [resolvedAdmin])
		saveCheckpoint(checkpoint)
	}

	// Updating an upgrade plan is unrelated to deploying a verifier and used to happen as
	// an implicit side effect. Keep it available only behind an explicit task option.
	if (updateUpgradeConfig) updateUpgradeConfigFile(address)

	if (logData) {
		writeSignatureVerifierRecord(address, resolvedAdmin)
		logger.debug("Deployed addresses written to JSON file")
	}

	return contract
}

function writeSignatureVerifierRecord(address: string, admin: string): void {
	upsertDeploymentRecords(DEPLOYMENT_LOG_FILE, [{ name: "MuonSignatureVerifier", address, constructorArguments: [admin] }])
}

function updateUpgradeConfigFile(address: string): void {
	const configPath = process.env.UPGRADE_CONFIG_FILE ?? DEFAULT_UPGRADE_CONFIG_FILE
	if (!fs.existsSync(configPath)) throw new Error(`Cannot update upgrade config; file not found: ${configPath}`)
	const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
	if (!config.newV085Parameters) config.newV085Parameters = {}
	config.newV085Parameters.signatureVerifierAddress = address
	atomicWriteFile(configPath, JSON.stringify(config, null, "\t") + "\n")
	logger.info(`  ✅ Written signatureVerifierAddress to ${configPath}`)
}

export const signatureVerifierTask = task("deploy:signatureVerifier", "Deploys the MuonSignatureVerifier")
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.addOption({
		name: "updateUpgradeConfig",
		description: "Explicitly write the deployed address into UPGRADE_CONFIG_FILE",
		type: ArgumentType.BOOLEAN,
		defaultValue: false,
	})
	.setAction(async () => ({
		default: async ({ admin, logData, updateUpgradeConfig }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:signatureVerifier")
			return deploySignatureVerifier(hre, { admin, logData, updateUpgradeConfig })
		},
	}))
	.build()
