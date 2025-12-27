import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { deployProxyWithFallback, getConnection, getUpgradeAddresses } from "./helpers.js"

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
		default: async ({ symmioAddress, admin, symmioShareReceiver, symmioShare }, hre) => {
			const { ethers, upgrades } = await getConnection(hre)
			console.log("Running deploy:feeDistributor")

			const [deployer] = await ethers.getSigners()

			console.log("Deploying contracts with the account:", deployer.address)

			// Deploy SymmioFeeDistributor as upgradeable
			const factory = await ethers.getContractFactory("SymmioFeeDistributor")
			const contract = await deployProxyWithFallback(hre, factory, [admin, symmioAddress, symmioShareReceiver, symmioShare], {
				initializer: "initialize",
				kind: "transparent",
			})
			await contract.waitForDeployment()

			const addresses = {
				proxy: await contract.getAddress(),
				...(await getUpgradeAddresses(upgrades, contract)),
			}
			console.log("SymmioFeeDistributor deployed to", addresses)

			return contract
		},
	}))
	.build()
