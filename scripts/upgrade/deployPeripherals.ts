/**
 * Deploy v0.8.5 peripheral contracts: AccountLayer Diamond, InstantLayer,
 * and SymmioPartyB implementation.
 *
 * These contracts are independent of the core diamond and can be deployed
 * before the upgrade. Resume-safe via state file.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/deployPeripherals.ts --network arbitrum
 *
 *   # Custom config
 *   DEPLOY_PERIPHERALS_CONFIG=./path/to/config.json \
 *     npx hardhat run scripts/upgrade/deployPeripherals.ts --network arbitrum
 *
 * Config: scripts/upgrade/config/deployPeripherals.json
 *   {
 *     "diamondAddress": "0x...",       // Core Symmio diamond (InstantLayer constructor arg)
 *     "adminAddress": "0x...",         // Admin/owner for contracts
 *     "symmioFeeReceiver": "0x...",    // Fee receiver for AccountLayer init
 *     "symmioPartyBAddress": "0x..."   // Existing SymmioPartyB proxy (for InstantLayer registration)
 *   }
 *
 * Output: scripts/upgrade/output/deployed-peripherals.json
 */
import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { deployAccountLayerDiamond, deployInstantLayer } from "./utils/peripheralHelpers.js"

type Config = {
	diamondAddress: string
	adminAddress: string
	symmioFeeReceiver: string
	symmioPartyBAddress?: string
}

type DeployedState = {
	accountLayer?: any
	instantLayer?: any
	symmioPartyBImplementation?: string
}

const CONFIG_FILE = process.env.DEPLOY_PERIPHERALS_CONFIG ?? "./scripts/upgrade/config/deployPeripherals.json"
const OUTPUT_DIR = "./scripts/upgrade/output"
const STATE_FILE = path.join(OUTPUT_DIR, "deployed-peripherals.json")

function loadConfig(): Config {
	if (!fs.existsSync(CONFIG_FILE)) {
		throw new Error(`Config file not found: ${CONFIG_FILE}\nCopy config/samples/deployPeripherals.sample.json and fill in the values.`)
	}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

function loadState(): DeployedState {
	if (!fs.existsSync(STATE_FILE)) return {}
	return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as DeployedState
}

function saveState(state: DeployedState): void {
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function main() {
	const config = loadConfig()

	const { diamondAddress, adminAddress, symmioFeeReceiver, symmioPartyBAddress } = config

	if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
		throw new Error("diamondAddress is required and must be a valid address")
	}
	if (!adminAddress || !ethers.isAddress(adminAddress)) {
		throw new Error("adminAddress is required and must be a valid address")
	}
	if (!symmioFeeReceiver || !ethers.isAddress(symmioFeeReceiver)) {
		throw new Error("symmioFeeReceiver is required and must be a valid address")
	}
	if (symmioPartyBAddress && !ethers.isAddress(symmioPartyBAddress)) {
		throw new Error("symmioPartyBAddress must be a valid address")
	}

	console.log(`Diamond (core):      ${diamondAddress}`)
	console.log(`Admin:               ${adminAddress}`)
	console.log(`Fee receiver:        ${symmioFeeReceiver}`)
	console.log(`SymmioPartyB proxy:  ${symmioPartyBAddress || "(not set)"}`)
	console.log()

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	// Deploy AccountLayer Diamond
	console.log("=== AccountLayer Diamond ===")
	const alResult = await deployAccountLayerDiamond(adminAddress, symmioFeeReceiver, STATE_FILE)

	// Deploy InstantLayer
	console.log("\n=== InstantLayer ===")
	const ilResult = await deployInstantLayer(diamondAddress, adminAddress, STATE_FILE)

	// Deploy SymmioPartyB implementation
	console.log("\n=== SymmioPartyB Implementation ===")
	const state = loadState()
	let symmioPartyBImpl: string

	if (state.symmioPartyBImplementation) {
		symmioPartyBImpl = state.symmioPartyBImplementation
		console.log(`  SymmioPartyB implementation: ${symmioPartyBImpl} (cached)`)
	} else {
		console.log("  Deploying SymmioPartyB implementation...")
		const factory = await ethers.getContractFactory("SymmioPartyB")
		const contract = await factory.deploy()
		await contract.waitForDeployment()
		symmioPartyBImpl = await contract.getAddress()
		state.symmioPartyBImplementation = symmioPartyBImpl
		saveState(state)
		console.log(`  SymmioPartyB implementation: ${symmioPartyBImpl}`)
	}

	// Summary
	console.log("\n=== Deployment Complete ===")
	console.log(`  AccountLayer Diamond:          ${alResult.diamondAddress}`)
	console.log(`  InstantLayer:                  ${ilResult.address}`)
	console.log(`  SymmioPartyB implementation:   ${symmioPartyBImpl}`)
	console.log(`  State file:                    ${STATE_FILE}`)

	console.log("\nAdd these to your upgrade.json:")
	const output: Record<string, string> = {
		accountLayerDiamondAddress: alResult.diamondAddress,
		instantLayerAddress: ilResult.address,
		symmioPartyBImplementation: symmioPartyBImpl,
	}
	if (symmioPartyBAddress) {
		output.symmioPartyBAddress = symmioPartyBAddress
	}
	console.log(JSON.stringify(output, null, 2))
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
