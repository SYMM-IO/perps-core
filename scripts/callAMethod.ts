import { ethers } from "../test/helpers/hardhat-connection.js"

async function main() {
	let symmioAddress = ""
	let ControlFacet = await ethers.getContractAt("contracts/facets/Control/ControlFacet.sol:ControlFacet", symmioAddress)
	console.log(
		await ControlFacet.grantRole("", ""),
	)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
