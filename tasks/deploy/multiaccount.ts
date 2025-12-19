import {task} from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"
import {readData, writeData} from "../utils/fs"
import {DEPLOYMENT_LOG_FILE} from "./constants"
import {deployProxy, erc1967} from "../../utils/upgrades-shim"

task("deploy:multiAccount", "Deploys the MultiAccount")
	.addOption({ name: "symmioAddress", description: "The address of the Symmio contract", defaultValue: "" })
	.addOption({ name: "admin", description: "The admin address", defaultValue: "" })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async ({symmioAddress, admin, logData}, hre) => {
		const { ethers } = hre
		console.log("Running deploy:multiAccount")

		const [deployer] = await ethers.getSigners()

		console.log("Deploying contracts with the account:", deployer.address)

		const SymmioPartyA = await ethers.getContractFactory("SymmioPartyA")

		// Deploy MultiAccount as upgradeable
		const Factory = await ethers.getContractFactory("MultiAccount")
		console.log(admin, symmioAddress)
		const contract = await deployProxy(hre, Factory, [admin, symmioAddress, SymmioPartyA.bytecode], {
			initializer: "initialize",
			admin,
		})

		const addresses = {
			proxy: await contract.getAddress(),
			admin: await erc1967(hre).getAdminAddress(await contract.getAddress()),
			implementation: await erc1967(hre).getImplementationAddress(await contract.getAddress()),
		}
		console.log("MultiAccount deployed to", addresses)

		if (logData) {
			// Read existing data
			let deployedData = []
			try {
				deployedData = readData(DEPLOYMENT_LOG_FILE)
			} catch (err) {
				console.error(`Could not read existing JSON file: ${err}`)
			}

			// Append new data
			deployedData.push(
				{
					name: "MultiAccountProxy",
					address: await contract.getAddress(),
					constructorArguments: [admin, symmioAddress, SymmioPartyA.bytecode],
				},
				{
					name: "MultiAccountAdmin",
					address: addresses.admin,
					constructorArguments: [],
				},
				{
					name: "MultiAccountImplementation",
					address: addresses.implementation,
					constructorArguments: [],
				}
			)

			// Write updated data back to JSON file
			writeData(DEPLOYMENT_LOG_FILE, deployedData)
			console.log("Deployed addresses written to JSON file")
		}

		return contract
	})
