/**
 * Deploy AccountLayer Diamond + InstantLayer for the v0.8.5 upgrade.
 *
 * Deploys both contracts and saves addresses to output. Resume-safe via
 * state file -- re-run to pick up where a previous run left off.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/deployAccountLayerInstantLayer.ts --network arbitrum
 *
 *   # Custom config
 *   DEPLOY_AL_IL_CONFIG=./path/to/config.json \
 *     npx hardhat run scripts/upgrade/deployAccountLayerInstantLayer.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/deployAccountLayerInstantLayer.json
 *   {
 *     "diamondAddress": "0x...",       // Core Symmio diamond (InstantLayer constructor arg)
 *     "adminAddress": "0x...",         // Admin/owner for both contracts
 *     "symmioFeeReceiver": "0x..."     // Fee receiver for AccountLayer init
 *   }
 *
 * Output: scripts/upgrade/output/deployed-accountlayer-instantlayer.json
 *   Prints accountLayerDiamondAddress and instantLayerAddress ready for upgrade.json.
 */
import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { deployAccountLayerDiamond, deployInstantLayer } from "./utils/deployAccountLayerInstantLayer.js"

type Config = {
	diamondAddress: string
	adminAddress: string
	symmioFeeReceiver: string
}

const CONFIG_FILE = process.env.DEPLOY_AL_IL_CONFIG ?? "./scripts/upgrade/config/deployAccountLayerInstantLayer.json"
const OUTPUT_DIR = "./scripts/upgrade/output"

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) {
		throw new Error(`Config file not found: ${CONFIG_FILE}\nCopy config/samples/deployAccountLayerInstantLayer.sample.json and fill in the values.`)
	}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

async function main() {
	const config = loadConfig()

	const diamondAddress = config.diamondAddress
	const adminAddress = config.adminAddress
	const symmioFeeReceiver = config.symmioFeeReceiver

	if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
		throw new Error("diamondAddress is required and must be a valid address")
	}
	if (!adminAddress || !ethers.isAddress(adminAddress)) {
		throw new Error("adminAddress is required and must be a valid address")
	}
	if (!symmioFeeReceiver || !ethers.isAddress(symmioFeeReceiver)) {
		throw new Error("symmioFeeReceiver is required and must be a valid address")
	}

	console.log(`Diamond (core):      ${diamondAddress}`)
	console.log(`Admin:               ${adminAddress}`)
	console.log(`Fee receiver:        ${symmioFeeReceiver}`)
	console.log()

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	const stateFile = path.join(OUTPUT_DIR, "deployed-accountlayer-instantlayer.json")

	// Deploy AccountLayer Diamond
	console.log("=== AccountLayer Diamond ===")
	const alResult = await deployAccountLayerDiamond(adminAddress, symmioFeeReceiver, stateFile)

	// Deploy InstantLayer
	console.log("\n=== InstantLayer ===")
	const ilResult = await deployInstantLayer(diamondAddress, adminAddress, stateFile)

	// Summary
	console.log("\n=== Deployment Complete ===")
	console.log(`  AccountLayer Diamond: ${alResult.diamondAddress}`)
	console.log(`  InstantLayer:         ${ilResult.address}`)
	console.log(`  State file:           ${stateFile}`)

	console.log("\nAdd these to your upgrade.json:")
	console.log(
		JSON.stringify(
			{
				accountLayerDiamondAddress: alResult.diamondAddress,
				instantLayerAddress: ilResult.address,
			},
			null,
			2,
		),
	)
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
