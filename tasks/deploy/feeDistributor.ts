import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { upsertDeploymentRecords } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import {
	assertStandaloneDeploymentTaskAllowed,
	checksumAddress,
	deployProxyWithFallback,
	getConnection,
	getUpgradeAddresses,
	requireArg,
} from "./helpers.js"
import { logger } from "./logger.js"

export const feeDistributorTask = task("deploy:feeDistributor", "Deploys the SymmioFeeDistributor")
	.addOption({
		name: "symmioAddress",
		description: "The address of the Symmio contract",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "symmioShare", description: "The symmio share", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({
		name: "symmioShareReceiver",
		description: "The symmio share receiver",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.setAction(async () => ({
		default: async ({ symmioAddress: rawSymmio, admin: rawAdmin, symmioShareReceiver: rawReceiver, symmioShare }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:feeDistributor")
			const { ethers, upgrades } = await getConnection(hre)
			logger.section("SymmioFeeDistributor Deployment")

			const admin = checksumAddress(requireArg(rawAdmin, "admin"))
			const symmioAddress = checksumAddress(requireArg(rawSymmio, "symmio-address"))
			const symmioShareReceiver = checksumAddress(requireArg(rawReceiver, "symmio-share-receiver"))

			const [deployer] = await ethers.getSigners()

			logger.debug("Deploying contracts with the account:", deployer.address)

			// Deploy SymmioFeeDistributor as upgradeable
			const factory = await ethers.getContractFactory("SymmioFeeDistributor")
			const contract = await deployProxyWithFallback(hre, factory, [admin, symmioAddress, symmioShareReceiver, symmioShare], {
				initializer: "initialize",
				kind: "transparent",
				label: "SymmioFeeDistributor",
				proxyKey: "peripherals/FeeDistributor",
			})

			const addresses = {
				proxy: await contract.getAddress(),
				...(await getUpgradeAddresses(upgrades, contract)),
			}
			logger.deployed("SymmioFeeDistributor (Proxy)", addresses.proxy)
			if (addresses.implementation) {
				logger.deployed("SymmioFeeDistributor (Implementation)", addresses.implementation)
			}
			if (addresses.admin) {
				logger.deployed("SymmioFeeDistributor (Admin)", addresses.admin)
			}
			upsertDeploymentRecords(DEPLOYMENT_LOG_FILE, [
				{
					name: "SymmioFeeDistributorProxy",
					address: addresses.proxy,
					constructorArguments: [admin, symmioAddress, symmioShareReceiver, symmioShare],
				},
				...(addresses.implementation
					? [{ name: "SymmioFeeDistributorImplementation", address: addresses.implementation, constructorArguments: [] }]
					: []),
				...(addresses.admin ? [{ name: "SymmioFeeDistributorAdmin", address: addresses.admin, constructorArguments: [] }] : []),
			])

			return contract
		},
	}))
	.build()
