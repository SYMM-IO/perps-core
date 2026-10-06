import * as chai from "chai"
import hre from "hardhat"

import { setLogLevel } from "../../tasks/deploy/logger.js"

// Set log level to silent for tests (can be overridden with DEPLOY_LOG_LEVEL env var)
if (!process.env.DEPLOY_LOG_LEVEL) {
	setLogLevel("silent")
}

const connection = await hre.network.getOrCreate()
export const { ethers, networkHelpers } = connection
;(hre as any).ethers = (hre as any).ethers ?? ethers
;(hre as any).networkHelpers = (hre as any).networkHelpers ?? networkHelpers

// add revert for backwards compatibility!
chai.Assertion.addProperty("reverted", function () {
	return (this as any).revert(ethers)
})
export const network = hre.network
export { hre }
export default connection
