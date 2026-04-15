import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { writeData } from "../utils/fs.js"
import { DeploymentCheckpoint, createDeployedContract, saveCheckpoint } from "./checkpoint.js"
import { LIQUIDATOR_DEPLOYMENT_FILE } from "./constants.js"
import { checksumAddress, deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"
import { logger } from "./logger.js"

type DeploySymmioLiquidatorArgs = {
	symmioAddress: string
	admin: string
	logData?: boolean
	checkpoint?: DeploymentCheckpoint
}

export async function deploySymmioLiquidator(
	hre: any,
	{ symmioAddress: rawSymmio, admin: rawAdmin, logData = true, checkpoint }: DeploySymmioLiquidatorArgs,
) {
	const { ethers, upgrades } = await getConnection(hre)

	const admin = checksumAddress(rawAdmin)
	const symmioAddress = checksumAddress(rawSymmio)

	const [deployer] = await ethers.getSigners()
	logger.debug("Deploying SymmioLiquidator with account:", deployer.address)

	// Resume from checkpoint if already deployed
	if (checkpoint?.contracts.symmioLiquidator) {
		const address = checkpoint.contracts.symmioLiquidator.address
		logger.info(`  ⏭ SymmioLiquidator already deployed at ${address}`)
		return await ethers.getContractAt("SymmioLiquidator", address)
	}

	const Factory = await ethers.getContractFactory("SymmioLiquidator")
	const symmioLiquidator = await deployProxyWithFallback(hre, Factory, [admin, symmioAddress], { initializer: "initialize" })
	await symmioLiquidator.waitForDeployment()

	const addresses = {
		proxy: await symmioLiquidator.getAddress(),
		...(await getUpgradeAddresses(upgrades, symmioLiquidator)),
	}
	logger.deployed("SymmioLiquidator (Proxy)", addresses.proxy)
	if (addresses.implementation) logger.deployed("SymmioLiquidator (Implementation)", addresses.implementation)
	if (addresses.admin) logger.deployed("SymmioLiquidator (Admin)", addresses.admin)

	if (checkpoint) {
		checkpoint.contracts.symmioLiquidator = {
			...createDeployedContract(addresses.proxy, [admin, symmioAddress]),
			implementation: addresses.implementation,
			admin: addresses.admin,
		}
		saveCheckpoint(checkpoint)
	}

	if (logData) {
		const entries: Array<{ name: string; address: string; constructorArguments: any[] }> = [
			{
				name: "SymmioLiquidatorProxy",
				address: await symmioLiquidator.getAddress(),
				constructorArguments: [admin, symmioAddress],
			},
		]
		if (addresses.implementation) {
			entries.push({ name: "SymmioLiquidatorImplementation", address: addresses.implementation, constructorArguments: [] })
		}
		if (addresses.admin) {
			entries.push({ name: "SymmioLiquidatorAdmin", address: addresses.admin, constructorArguments: [] })
		}
		writeData(LIQUIDATOR_DEPLOYMENT_FILE, entries)
	}

	return symmioLiquidator
}

export const liquidatorTask = task("deploy:symmioLiquidator", "Deploys the SymmioLiquidator proxy")
	.addOption({
		name: "symmioAddress",
		description: "The address of the Symmio core diamond",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ symmioAddress, admin, logData }, hre) => deploySymmioLiquidator(hre, { symmioAddress, admin, logData }),
	}))
	.build()
