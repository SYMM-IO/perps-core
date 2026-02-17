import { toUtf8Bytes } from "ethers"

import { ethers } from "../test/helpers/hardhat-connection.js"

async function decodeCustomError(data: string, address: string) {
	const contract = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", address)
	const iface = new ethers.Interface(contract.interface.fragments)

	try {
		const parsed = iface.parseError(data)
		console.log("Custom error name:", parsed!.name)
		console.log("Custom error args:", parsed!.args)
	} catch (e) {
		console.log("Failed to parse error. Maybe no arguments? Only selector.")
	}
}

const symmioAddress = "0xa805FE5baA301D4e72C789694F3967452c77D6fD"

const [signer] = await ethers.getSigners()
const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", symmioAddress, signer)

try {
	const tx = await controlFacet.grantRole("0xFb480340F2DD912bb6D06F5B8e9Aa21b92BA93Bf", ethers.keccak256(toUtf8Bytes("SYMBOL_MANAGER_ROLE")))
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
