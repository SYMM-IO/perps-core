import { task } from "hardhat/config"

import { readData } from "../utils/fs.js"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE, AFFILIATEHUB_DEPLOYMENT_FILE, DEPLOYMENT_LOG_FILE, INSTANTLAYER_DEPLOYMENT_FILE } from "./constants.js"

const verifyDeploymentAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(DEPLOYMENT_LOG_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await hre.tasks.getTask("verify:verify").run({
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyAffiliateHubAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(AFFILIATEHUB_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await hre.tasks.getTask("verify:verify").run({
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyAccountHubAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(ACCOUNTHUB_DEPLOYMENT_LOG_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await hre.tasks.getTask("verify:verify").run({
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
}

const verifyInstantLayerAction = async (_: unknown, hre: any) => {
	const deployedAddresses = readData(INSTANTLAYER_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await hre.tasks.getTask("verify:verify").run({
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
}

export const verifyDeploymentTask = task("verify:deployment", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyDeploymentAction }))
	.build()

export const verifyAffiliateHubTask = task("verify:affiliateHub", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyAffiliateHubAction }))
	.build()

export const verifyAccountHubTask = task("verify:accountHub", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyAccountHubAction }))
	.build()

export const verifyInstantLayerTask = task("verify:instantLayer", "Verifies the deployed contracts")
	.setAction(async () => ({ default: verifyInstantLayerAction }))
	.build()
