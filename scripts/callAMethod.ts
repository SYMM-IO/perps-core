import { toUtf8Bytes } from "ethers"

import { ethers } from "../test/helpers/hardhat-connection.js"

async function main() {
	const symmioAddress = "0xeBf201d84CddC358C93450EC33c58D320B0c1d2A"

	const [signer] = await ethers.getSigners()
	const controlFacet = await ethers.getContractAt("ControlFacet", "0xeBf201d84CddC358C93450EC33c58D320B0c1d2A", signer)

	try {
		// const reg = {
		// 	name: "Vibe trading-2",
		// 	brandColor: "",
		// 	admin: "0xB3fF478E24eaa82182Ce691a660857b31464764B",
		// 	stakeholders: [
		// 		{
		// 			receiver: "0xB3fF478E24eaa82182Ce691a660857b31464764B",
		// 			share: ethers.parseEther("0.9"),
		// 		},
		// 	],
		// 	symmioShare: ethers.parseEther("0.1"),
		// 	metadata: "0x",
		// 	legacyMultiAccounts: ["0x86A34ba4586142c26C7c594f8baFc9C25dECc94a", "0x96CB0251D67Ea2a3E6a1e5b7B41F7cD63d6c530f"],
		// 	symmioCores: [symmioAddress],
		// }
		// const tx = await controlFacet.grantRole("0xc2297D77406179C7EA0247714d31A4aDd956FAF0", ethers.keccak256(toUtf8Bytes("SIGNER_ADMIN_ROLE")))
		ethers.keccak256(toUtf8Bytes("SIGNER_ADMIN_ROLE"))
		console.log("txHash:", tx.hash)
		await tx.wait()
	} catch (err: any) {
		console.log("Transaction failed!")

		if (err.reason) {
			console.log("Reason:", err.reason)
		} else if (err.errorName) {
			console.log("Custom error name:", err.errorName)
			console.log("Custom error args:", err.errorArgs)
		} else if (err.data || err.error?.data) {
			const data = err.data ?? err.error?.data
			console.log("Error data:", data)
			await decodeCustomError(data, symmioAddress)
		} else {
			console.log(err)
		}
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})

async function decodeCustomError(data: string, address: string) {
	const contract = await ethers.getContractAt("ControlFacet", address)
	const iface = new ethers.Interface(contract.interface.fragments)

	try {
		const parsed = iface.parseError(data)
		console.log("Custom error name:", parsed!.name)
		console.log("Custom error args:", parsed!.args)
	} catch (e) {
		console.log("Failed to parse error. Maybe no arguments? Only selector.")
	}
}

// import { ethers } from "../test/helpers/hardhat-connection.js"

// async function main() {
// 	const selector = ethers.id("onAccountCreation(address,address,bytes)").slice(0, 10)
// 	console.log("onAccountCreation selector:", selector)
// }

// main().catch(error => {
// 	console.error(error)
// 	process.exitCode = 1
// })
