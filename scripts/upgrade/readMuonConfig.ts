/**
 * Read Muon TSS public key and gateway signer from a v0.8.4 diamond.
 *
 * Outputs the values in a format ready to paste into upgrade.json
 * (newV085Parameters.muonPublicKeys / muonGatewaySigners).
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/upgrade/readMuonConfig.ts --network <network>
 *
 *   # Or with config file
 *   npx hardhat run scripts/upgrade/readMuonConfig.ts --network <network>
 */
import fs from "fs"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"

// v0.8.4 ViewFacet ABI (subset — getMuonIds returns the public key + gateway)
const V084_VIEW_ABI = [
	"function getMuonIds() external view returns (uint256 muonAppId, tuple(uint256 x, uint8 parity) muonPublicKey, address validGateway)",
	"function getMuonConfig() external view returns (uint256 upnlValidTime, uint256 priceValidTime)",
]

async function main() {
	const shared = loadUpgradeConfigShared()
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env var or upgrade.json)")

	console.log(`Reading Muon config from v0.8.4 diamond: ${DIAMOND_ADDRESS}\n`)

	const view = new ethers.Contract(DIAMOND_ADDRESS, V084_VIEW_ABI, ethers.provider)

	const [muonAppId, muonPublicKey, validGateway] = await view.getMuonIds()
	const [upnlValidTime, priceValidTime] = await view.getMuonConfig()

	const publicKeyX = muonPublicKey.x.toString()
	const publicKeyParity = Number(muonPublicKey.parity)

	console.log("Muon Config (from v0.8.4 diamond):")
	console.log("---")
	console.log(`  muonAppId:       ${muonAppId.toString()}`)
	console.log(`  publicKey.x:     ${publicKeyX}`)
	console.log(`  publicKey.parity: ${publicKeyParity}`)
	console.log(`  validGateway:    ${validGateway}`)
	console.log(`  upnlValidTime:   ${upnlValidTime.toString()}`)
	console.log(`  priceValidTime:  ${priceValidTime.toString()}`)
	console.log()

	if (publicKeyX === "0" && validGateway === ethers.ZeroAddress) {
		console.log("WARNING: Public key and gateway are both zero — Muon was not configured on this diamond.")
		console.log("         No seeding needed for the MuonSignatureVerifier.")
		return
	}

	// Build the config snippet
	const configSnippet: Record<string, any> = {}

	if (publicKeyX !== "0") {
		configSnippet.muonPublicKeys = [{ x: publicKeyX, parity: publicKeyParity }]
	}
	if (validGateway !== ethers.ZeroAddress) {
		configSnippet.muonGatewaySigners = [validGateway]
	}

	console.log("Add the following to upgrade.json -> newV085Parameters:\n")
	console.log(JSON.stringify(configSnippet, null, 2))

	// Write to output file
	const OUTPUT_DIR = "./scripts/upgrade/output"
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const outputFile = `${OUTPUT_DIR}/muon-config.json`
	const fullOutput = {
		readFromDiamond: DIAMOND_ADDRESS,
		readAt: new Date().toISOString(),
		muonAppId: muonAppId.toString(),
		upnlValidTime: upnlValidTime.toString(),
		priceValidTime: priceValidTime.toString(),
		muonPublicKey: { x: publicKeyX, parity: publicKeyParity },
		validGateway,
		configSnippet,
	}
	fs.writeFileSync(outputFile, JSON.stringify(fullOutput, null, 2))
	console.log(`\nFull output written to: ${outputFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
