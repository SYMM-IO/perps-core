import hre from "hardhat"
import * as chai from "chai"

const connection = await hre.network.connect()
export const { ethers, networkHelpers } = connection

const initialBlock = await connection.ethers.provider.getBlock("latest")
console.log("Hardhat block gas limit", initialBlock?.gasLimit?.toString?.())

	; (hre as any).ethers = (hre as any).ethers ?? ethers
	; (hre as any).networkHelpers = (hre as any).networkHelpers ?? networkHelpers

// add revert for backwards compatibility!
chai.Assertion.addProperty("reverted", function () {
	return (this as any).revert(ethers)
})
export const network = hre.network
export { hre }
export default connection
