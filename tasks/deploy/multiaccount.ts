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

export const multiaccountTask = task("deploy:multiAccount", "Deploys the MultiAccount")
	.addOption({
		name: "symmioAddress",
		description: "The address of the Symmio contract",
		type: ArgumentType.STRING_WITHOUT_DEFAULT,
		defaultValue: undefined,
	})
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ symmioAddress: rawSymmio, admin: rawAdmin, logData }, hre) => {
			await assertStandaloneDeploymentTaskAllowed(hre, "deploy:multiAccount")
			const { ethers, upgrades } = await getConnection(hre)
			logger.section("MultiAccount Deployment")

			const admin = checksumAddress(requireArg(rawAdmin, "admin"))
			const symmioAddress = checksumAddress(requireArg(rawSymmio, "symmio-address"))

			const [deployer] = await ethers.getSigners()

			logger.debug("Deploying contracts with the account:", deployer.address)

			const SymmioPartyA = await ethers.getContractFactory("SymmioPartyA")

			// Deploy MultiAccount as upgradeable
			const Factory = await ethers.getContractFactory("MultiAccount")
			logger.debug("Admin:", admin, "Symmio:", symmioAddress)
			const contract = await deployProxyWithFallback(hre, Factory, [admin, symmioAddress, SymmioPartyA.bytecode], {
				initializer: "initialize",
				label: "MultiAccount",
				proxyKey: "peripherals/MultiAccount",
			})

			const addresses = {
				proxy: await contract.getAddress(),
				...(await getUpgradeAddresses(upgrades, contract)),
			}
			logger.deployed("MultiAccount (Proxy)", addresses.proxy)
			if (addresses.implementation) {
				logger.deployed("MultiAccount (Implementation)", addresses.implementation)
			}
			if (addresses.admin) {
				logger.deployed("MultiAccount (Admin)", addresses.admin)
			}

			if (logData) {
				upsertDeploymentRecords(DEPLOYMENT_LOG_FILE, [
					{
						name: "MultiAccountProxy",
						address: await contract.getAddress(),
						constructorArguments: [admin, symmioAddress, SymmioPartyA.bytecode],
					},
					...(addresses.admin ? [{ name: "MultiAccountAdmin", address: addresses.admin, constructorArguments: [] }] : []),
					...(addresses.implementation ? [{ name: "MultiAccountImplementation", address: addresses.implementation, constructorArguments: [] }] : []),
				])
				logger.debug("Deployed addresses written to JSON file")
			}

			return contract
		},
	}))
	.build()
