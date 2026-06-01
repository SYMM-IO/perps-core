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

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import { baseNetworkName, loadUpgradeConfigShared } from "./utils/sharedConfig.js"

type MuonConfigOutput = {
	sourceVersion: "v0.8.4" | "v0.8.5"
	readFromDiamond: string
	readAt: string
	muonAppId: string
	upnlValidTime: string
	priceValidTime: string
	signatureVerifierAddress?: string
	muonPublicKeys: Array<{ x: string; parity: number }>
	muonGatewaySigners: string[]
	configSnippet: Record<string, any>
}

// v0.8.4 ViewFacet ABI (subset — getMuonIds returns appId + public key + gateway)
const V084_VIEW_ABI = [
	"function getMuonIds() external view returns (uint256 muonAppId, tuple(uint256 x, uint8 parity) muonPublicKey, address validGateway)",
	"function getMuonConfig() external view returns (uint256 upnlValidTime, uint256 priceValidTime)",
]

// v0.8.5 ViewFacet ABI. Public keys and gateway signers live on MuonSignatureVerifier.
const V085_VIEW_ABI = [
	"function getMuonIds() external view returns (uint256 muonAppId)",
	"function getMuonConfig() external view returns (uint256 upnlValidTime, uint256 priceValidTime)",
	"function getSignatureVerifier() external view returns (address)",
]

const VERIFIER_ABI = [
	"function getAllPublicKeys() external view returns (tuple(uint256 x, uint8 parity)[])",
	"function getAllGatewaySigners() external view returns (address[])",
]

function normalizePublicKey(key: any): { x: string; parity: number } {
	return {
		x: key.x.toString(),
		parity: Number(key.parity),
	}
}

function buildConfigSnippet(output: Omit<MuonConfigOutput, "configSnippet">): Record<string, any> {
	const configSnippet: Record<string, any> = {}
	if (output.signatureVerifierAddress) {
		configSnippet.signatureVerifierAddress = output.signatureVerifierAddress
	}
	if (output.muonPublicKeys.length > 0) {
		configSnippet.muonPublicKeys = output.muonPublicKeys
	}
	if (output.muonGatewaySigners.length > 0) {
		configSnippet.muonGatewaySigners = output.muonGatewaySigners
	}
	return configSnippet
}

async function readV084Config(diamondAddress: string): Promise<MuonConfigOutput> {
	const view = new ethers.Contract(diamondAddress, V084_VIEW_ABI, ethers.provider)

	const [muonAppId, muonPublicKey, validGateway] = await view.getMuonIds()
	const [upnlValidTime, priceValidTime] = await view.getMuonConfig()
	const publicKey = normalizePublicKey(muonPublicKey)
	const muonPublicKeys = publicKey.x === "0" ? [] : [publicKey]
	const muonGatewaySigners = validGateway === ethers.ZeroAddress ? [] : [ethers.getAddress(validGateway)]

	const outputWithoutSnippet = {
		sourceVersion: "v0.8.4" as const,
		readFromDiamond: diamondAddress,
		readAt: new Date().toISOString(),
		muonAppId: muonAppId.toString(),
		upnlValidTime: upnlValidTime.toString(),
		priceValidTime: priceValidTime.toString(),
		muonPublicKeys,
		muonGatewaySigners,
	}

	return {
		...outputWithoutSnippet,
		configSnippet: buildConfigSnippet(outputWithoutSnippet),
	}
}

async function readV085Config(diamondAddress: string): Promise<MuonConfigOutput> {
	const view = new ethers.Contract(diamondAddress, V085_VIEW_ABI, ethers.provider)

	const [muonAppId, [upnlValidTime, priceValidTime], signatureVerifierAddressRaw] = await Promise.all([
		view.getMuonIds(),
		view.getMuonConfig(),
		view.getSignatureVerifier(),
	])
	const signatureVerifierAddress = ethers.getAddress(signatureVerifierAddressRaw)
	const verifierCode = await ethers.provider.getCode(signatureVerifierAddress)
	const verifier = new ethers.Contract(signatureVerifierAddress, VERIFIER_ABI, ethers.provider)
	const [publicKeysRaw, gatewaySignersRaw] =
		signatureVerifierAddress === ethers.ZeroAddress || verifierCode === "0x"
			? [[], []]
			: await Promise.all([verifier.getAllPublicKeys(), verifier.getAllGatewaySigners()])

	const outputWithoutSnippet = {
		sourceVersion: "v0.8.5" as const,
		readFromDiamond: diamondAddress,
		readAt: new Date().toISOString(),
		muonAppId: muonAppId.toString(),
		upnlValidTime: upnlValidTime.toString(),
		priceValidTime: priceValidTime.toString(),
		signatureVerifierAddress,
		muonPublicKeys: publicKeysRaw.map(normalizePublicKey),
		muonGatewaySigners: gatewaySignersRaw.map((address: string) => ethers.getAddress(address)),
	}

	return {
		...outputWithoutSnippet,
		configSnippet: buildConfigSnippet(outputWithoutSnippet),
	}
}

async function readMuonConfig(diamondAddress: string): Promise<MuonConfigOutput> {
	try {
		return await readV084Config(diamondAddress)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.log(`v0.8.4 Muon read shape failed, trying v0.8.5 shape...`)
		console.log(`  ${message}`)
		console.log()
		return readV085Config(diamondAddress)
	}
}

async function main() {
	const networkSuffix = baseNetworkName(connection.networkName)
	const shared = loadUpgradeConfigShared(networkSuffix)
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? shared.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env var or upgrade.json)")

	console.log(`Reading Muon config from diamond: ${DIAMOND_ADDRESS}\n`)

	const output = await readMuonConfig(DIAMOND_ADDRESS)

	console.log(`Muon Config (from ${output.sourceVersion} diamond):`)
	console.log("---")
	console.log(`  muonAppId:       ${output.muonAppId}`)
	console.log(`  upnlValidTime:   ${output.upnlValidTime}`)
	console.log(`  priceValidTime:  ${output.priceValidTime}`)
	if (output.signatureVerifierAddress) {
		console.log(`  verifier:        ${output.signatureVerifierAddress}`)
	}
	console.log(`  public keys:     ${output.muonPublicKeys.length}`)
	for (const key of output.muonPublicKeys) {
		console.log(`    x:             ${key.x}`)
		console.log(`    parity:        ${key.parity}`)
	}
	console.log(`  gateway signers: ${output.muonGatewaySigners.length}`)
	for (const signer of output.muonGatewaySigners) {
		console.log(`    ${signer}`)
	}
	console.log()

	if (output.muonPublicKeys.length === 0 && output.muonGatewaySigners.length === 0) {
		console.log("WARNING: No Muon public keys or gateway signers were found.")
		console.log("         No seeding needed for the MuonSignatureVerifier.")
		return
	}

	console.log("Add the following to upgrade.json -> newV085Parameters:\n")
	console.log(JSON.stringify(output.configSnippet, null, 2))

	// Write to output file
	const OUTPUT_DIR = "./scripts/upgrade/output"
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	const outputFile = `${OUTPUT_DIR}/${networkSuffix ? `muon-config-${networkSuffix}.json` : "muon-config.json"}`
	fs.writeFileSync(outputFile, JSON.stringify(output, null, 2))
	console.log(`\nFull output written to: ${outputFile}`)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
