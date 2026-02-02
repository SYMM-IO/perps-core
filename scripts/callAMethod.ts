import { toUtf8Bytes } from "ethers"

import { ethers } from "../test/helpers/hardhat-connection.js"

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

const symmioAddress = ""

const [signer] = await ethers.getSigners()
const controlFacet = await ethers.getContractAt("ControlFacet", "", signer)

try {
	const tx = await controlFacet.grantRole("", ethers.keccak256(toUtf8Bytes("SIGNER_ADMIN_ROLE")))
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
