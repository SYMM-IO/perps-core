import hre from "hardhat"
import * as chai from "chai"
import { setLogLevel } from "../../tasks/deploy/logger.js"

// Set log level to silent for tests (can be overridden with DEPLOY_LOG_LEVEL env var)
if (!process.env.DEPLOY_LOG_LEVEL) {
	setLogLevel("silent")
}

// Suppress ethers.js Invalid Fragment warnings (caused by enum types in ABI)
// These warnings occur because LibQuoteParams uses ISymmio.PositionType enum which ethers can't parse
const originalLog = console.log
const originalWarn = console.warn
const suppressPattern = /Invalid Fragment|invalid type.*ISymmio/

console.log = (...args: any[]) => {
	const msg = args[0]?.toString?.() || ""
	if (suppressPattern.test(msg)) {
		return
	}
	originalLog.apply(console, args)
}

console.warn = (...args: any[]) => {
	const msg = args[0]?.toString?.() || ""
	if (suppressPattern.test(msg)) {
		return
	}
	originalWarn.apply(console, args)
}

const connection = await hre.network.connect()
export const { ethers, networkHelpers } = connection

	; (hre as any).ethers = (hre as any).ethers ?? ethers
	; (hre as any).networkHelpers = (hre as any).networkHelpers ?? networkHelpers

// add revert for backwards compatibility!
chai.Assertion.addProperty("reverted", function () {
	return (this as any).revert(ethers)
})
export const network = hre.network
export { hre }
export default connection
