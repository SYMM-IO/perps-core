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
 * Config: Reads from upgrade.json by default. Optional deployPeripherals.json overrides any field.
 *   Required fields (from either source): diamondAddress, protocolAdmin, symmioFeeReceiver
 *
 * Output: scripts/upgrade/output/deployed-peripherals.json
 */
import fs from "fs"
import path from "path"

import { ethers } from "../../test/helpers/hardhat-connection.js"
import { log } from "./utils/log.js"
import { deployAccountLayerDiamond, deployInstantLayer } from "./utils/peripheralHelpers.js"
import { loadUpgradeConfigShared } from "./utils/sharedConfig.js"

type Config = {
	diamondAddress?: string
	protocolAdmin: string
	symmioFeeReceiver: string
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
	const shared = loadUpgradeConfigShared()
	const raw: Partial<Config> = fs.existsSync(CONFIG_FILE)
		? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
		: {}
	return {
		diamondAddress: raw.diamondAddress ?? shared.diamondAddress,
		protocolAdmin: raw.protocolAdmin ?? shared.protocolAdmin ?? "",
		symmioFeeReceiver: raw.symmioFeeReceiver ?? shared.symmioFeeReceiver ?? "",
	}
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

	const { diamondAddress, protocolAdmin, symmioFeeReceiver } = config

	if (!diamondAddress || !ethers.isAddress(diamondAddress)) {
		throw new Error("diamondAddress is required and must be a valid address")
	}
	if (!protocolAdmin || !ethers.isAddress(protocolAdmin)) {
		throw new Error("protocolAdmin is required and must be a valid address")
	}
	if (!symmioFeeReceiver || !ethers.isAddress(symmioFeeReceiver)) {
		throw new Error("symmioFeeReceiver is required and must be a valid address")
	}
	log.header("Deploy v0.8.5 Peripherals")
	log.kv("Diamond (core)", log.addr(diamondAddress))
	log.kv("Protocol admin", log.addr(protocolAdmin))
	log.kv("Fee receiver", log.addr(symmioFeeReceiver))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	log.setSteps(3)

	// Deploy AccountLayer Diamond
	let t = log.step("AccountLayer Diamond")
	const alResult = await deployAccountLayerDiamond(protocolAdmin, symmioFeeReceiver, STATE_FILE)
	log.stepDone(t)

	// Deploy InstantLayer
	t = log.step("InstantLayer")
	const ilResult = await deployInstantLayer(diamondAddress, protocolAdmin, STATE_FILE)
	log.stepDone(t)

	// Deploy SymmioPartyB implementation
	t = log.step("SymmioPartyB Implementation")
	const state = loadState()
	let symmioPartyBImpl: string

	if (state.symmioPartyBImplementation) {
		symmioPartyBImpl = state.symmioPartyBImplementation
		log.deployed("SymmioPartyB", symmioPartyBImpl, true)
	} else {
		const factory = await ethers.getContractFactory("SymmioPartyB")
		const contract = await factory.deploy()
		symmioPartyBImpl = await contract.getAddress()
		state.symmioPartyBImplementation = symmioPartyBImpl
		saveState(state)
		await contract.waitForDeployment()
		log.deployed("SymmioPartyB", symmioPartyBImpl)
	}
	log.stepDone(t)

	// Summary
	log.success("Peripheral deployment complete", [
		["AccountLayer Diamond", alResult.diamondAddress],
		["InstantLayer", ilResult.address],
		["SymmioPartyB impl", symmioPartyBImpl],
		["State file", STATE_FILE],
	])

	log.nextSteps(["Run generateSafeBatch.ts (peripheral addresses are auto-loaded from deployed-peripherals.json)"])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
