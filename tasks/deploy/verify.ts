import { task } from "hardhat/config"

import { readData } from "../utils/fs"
import { ACCOUNTHUB_DEPLOYMENT_LOG_FILE, AFFILIATEHUB_DEPLOYMENT_FILE, DEPLOYMENT_LOG_FILE, INSTANTLAYER_DEPLOYMENT_FILE } from "./constants"

task("verify:deployment", "Verifies the deployed contracts").setAction(async (_, { run }) => {
	const deployedAddresses = readData(DEPLOYMENT_LOG_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await run("verify:verify", {
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
})

task("verify:affiliateHub", "Verifies the deployed contracts").setAction(async (_, { run }) => {
	const deployedAddresses = readData(AFFILIATEHUB_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await run("verify:verify", {
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
})

task("verify:accountHub", "Verifies the deployed contracts").setAction(async (_, { run }) => {
	const deployedAddresses = readData(ACCOUNTHUB_DEPLOYMENT_LOG_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await run("verify:verify", {
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
})

task("verify:instantLayer", "Verifies the deployed contracts").setAction(async (_, { run }) => {
	const deployedAddresses = readData(INSTANTLAYER_DEPLOYMENT_FILE)

	for (const address of deployedAddresses) {
		try {
			console.log(`Verifying ${address.address}`)
			await run("verify:verify", {
				address: address.address,
				constructorArguments: address.constructorArguments,
			})
		} catch (err) {
			console.error(err)
		}
	}
})
