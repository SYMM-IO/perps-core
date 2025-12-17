import { task } from "hardhat/config"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { ArgumentType } from "hardhat/types/arguments"
import { readData, writeData } from "../utils/fs"
import { DEPLOYMENT_LOG_FILE } from "./constants"
import { deployProxy, erc1967 } from "../../utils/upgrades-shim"

export async function deploySymmioPartyB(
	hre: HardhatRuntimeEnvironment,
	{ symmioAddress = "", admin = "", logData = true }: { symmioAddress?: string; admin?: string; logData?: boolean } = {},
) {
	const { ethers } = hre
	console.log("Running deploy:symmioPartyB")

	const [deployer] = await ethers.getSigners()
	console.log("Deploying contracts with the account:", deployer.address)

	// Deploy SymmioPartyB as upgradeable
	const SymmioPartyBFactory = await ethers.getContractFactory("SymmioPartyB")
	const symmioPartyB = await deployProxy(hre, SymmioPartyBFactory, [admin, symmioAddress], {
		initializer: "initialize",
		admin,
	})

	console.log("SymmioPartyB deployed to", {
		proxy: await symmioPartyB.getAddress(),
		admin: await erc1967(hre).getAdminAddress(await symmioPartyB.getAddress()),
		implementation: await erc1967(hre).getImplementationAddress(await symmioPartyB.getAddress()),
	})

	if (logData) {
		let deployedData = []
		try {
			deployedData = readData(DEPLOYMENT_LOG_FILE)
		} catch (err) {
			console.error(`Could not read existing JSON file: ${err}`)
		}

		// Append new data
		deployedData.push(
			{
				name: "SymmioPartyBProxy",
				address: await symmioPartyB.getAddress(),
				constructorArguments: [admin, symmioAddress],
			},
			{
				name: "SymmioPartyBAdmin",
				address: await erc1967(hre).getAdminAddress(await symmioPartyB.getAddress()),
				constructorArguments: [],
			},
			{
				name: "SymmioPartyBImplementation",
				address: await erc1967(hre).getImplementationAddress(await symmioPartyB.getAddress()),
				constructorArguments: [],
			},
		)

		// Write updated data back to JSON file
		writeData(DEPLOYMENT_LOG_FILE, deployedData)
		console.log("Deployed addresses written to JSON file")
	}

	return symmioPartyB
}

task("deploy:symmioPartyB", "Deploys the SymmioPartyB")
	.addOption({ name: "symmioAddress", description: "The address of the Symmio contract", defaultValue: "" })
	.addOption({ name: "admin", description: "The admin address", defaultValue: "" })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async (taskArgs, hre) => deploySymmioPartyB(hre, taskArgs))
