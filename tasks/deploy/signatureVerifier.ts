import { task } from "hardhat/config"
import { ArgumentType } from "hardhat/types/arguments"

import { readData, writeData } from "../utils/fs.js"
import { DEPLOYMENT_LOG_FILE } from "./constants.js"
import { getConnection } from "./helpers.js"

export const signatureVerifierTask = task("deploy:signatureVerifier", "Deploys the MuonSignatureVerifier")
	.addOption({ name: "admin", description: "The admin address", type: ArgumentType.STRING_WITHOUT_DEFAULT, defaultValue: undefined })
	.addOption({ name: "logData", description: "Write the deployed addresses to a data file", type: ArgumentType.BOOLEAN, defaultValue: true })
	.setAction(async () => ({
		default: async ({ admin, logData }, hre) => {
			const { ethers } = await getConnection(hre)
			console.log("Running deploy:signatureVerifier")

			const [deployer] = await ethers.getSigners()
			console.log("Deploying MuonSignatureVerifier with account:", deployer.address)

			const factory = await ethers.getContractFactory("MuonSignatureVerifier")
			const contract = await factory.connect(deployer).deploy(admin)
			await contract.waitForDeployment()
			await contract.deploymentTransaction()!.wait()

			const address = await contract.getAddress()
			console.log("MuonSignatureVerifier deployed to", address)

			if (logData) {
				let deployedData = []
				try {
					deployedData = readData(DEPLOYMENT_LOG_FILE)
				} catch (err) {
					console.error(`Could not read existing JSON file: ${err}`)
				}

				deployedData.push({
					name: "MuonSignatureVerifier",
					address,
					constructorArguments: [admin],
				})

				writeData(DEPLOYMENT_LOG_FILE, deployedData)
				console.log("Deployed addresses written to JSON file")
			}

			return contract
		},
	}))
	.build()
