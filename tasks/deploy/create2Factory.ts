import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { assertStandaloneDeploymentTaskAllowed, getConnection } from "./helpers.js"
import { logger } from "./logger.js"
import { confirmDeployment } from "./tx.js"

const CREATE2FACTORY_DEPLOYMENT_FILE = "create2factory.json"

export async function deployCreate2Factory(hre: any, { logData = true }: { logData?: boolean } = {}) {
	const { ethers } = await getConnection(hre)

	logger.section("Create2Factory Deployment")

	const [deployer] = await ethers.getSigners()
	logger.debug("Deploying Create2Factory with account:", deployer.address)

	const factory = await ethers.getContractFactory("Create2Factory")
	const contract = await factory.connect(deployer).deploy()
	const address = await confirmDeployment(contract, "Create2Factory")
	logger.deployed("Create2Factory", address)

	if (logData) {
		writeData(CREATE2FACTORY_DEPLOYMENT_FILE, [
			{
				name: "Create2Factory",
				address,
				constructorArguments: [],
			},
		])
		logger.debug("Deployed address written to JSON file")
	}

	console.log(`\nSet this in your .env for future deployments:`)
	console.log(`CREATE2_FACTORY_ADDRESS="${address}"`)

	return contract
}

export const create2FactoryTask = task("deploy:create2factory", "Deploys the Create2Factory for deterministic address deployments")
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(
				hre,
				"deploy:create2factory",
				"For live deployment, use an already reviewed CREATE2 factory address or omit CREATE2_FACTORY_ADDRESS to use ordinary CREATE.",
			)
			return deployCreate2Factory(hre, { logData })
		},
	}))
	.build()
