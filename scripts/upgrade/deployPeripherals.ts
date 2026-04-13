/**
 * Deploy v0.8.5 peripheral contracts: MuonSignatureVerifier, AccountLayer Diamond,
 * InstantLayer, and SymmioPartyB implementation.
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
	signatureVerifier?: string
	accountLayer?: any
	instantLayer?: any
	symmioPartyBImplementation?: string
}

const CONFIG_FILE = process.env.DEPLOY_PERIPHERALS_CONFIG ?? "./scripts/upgrade/config/deployPeripherals.json"
const UPGRADE_CONFIG_FILE = process.env.UPGRADE_CONFIG_FILE ?? "./scripts/upgrade/config/upgrade.json"
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

	log.setSteps(4)

	// Deploy MuonSignatureVerifier
	let t = log.step("MuonSignatureVerifier")
	const state0 = loadState()
	let signatureVerifierAddr: string

	if (state0.signatureVerifier) {
		signatureVerifierAddr = state0.signatureVerifier
		log.deployed("MuonSignatureVerifier", signatureVerifierAddr, true)
	} else {
		const factory = await ethers.getContractFactory("MuonSignatureVerifier")
		const contract = await factory.deploy(protocolAdmin)
		signatureVerifierAddr = await contract.getAddress()
		state0.signatureVerifier = signatureVerifierAddr
		saveState(state0)
		await contract.waitForDeployment()
		log.deployed("MuonSignatureVerifier", signatureVerifierAddr)
	}

	// Write address back to upgrade.json
	if (fs.existsSync(UPGRADE_CONFIG_FILE)) {
		const upgradeConfig = JSON.parse(fs.readFileSync(UPGRADE_CONFIG_FILE, "utf-8"))
		if (!upgradeConfig.newV085Parameters) upgradeConfig.newV085Parameters = {}
		upgradeConfig.newV085Parameters.signatureVerifierAddress = signatureVerifierAddr
		fs.writeFileSync(UPGRADE_CONFIG_FILE, JSON.stringify(upgradeConfig, null, "\t") + "\n")
		log.kv("Written signatureVerifierAddress to", UPGRADE_CONFIG_FILE)
	}
	log.stepDone(t)

	// Deploy AccountLayer Diamond
	t = log.step("AccountLayer Diamond")
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
		["MuonSignatureVerifier", signatureVerifierAddr],
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
