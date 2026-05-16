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
 * Output: scripts/upgrade/output/deployed-peripherals-{network}.json
 */
import fs from "fs"
import path from "path"

import connection, { ethers } from "../../test/helpers/hardhat-connection.js"
import {
	loadDeploymentState,
	saveDeploymentState,
	resolveDeploymentStateMetadata,
	type DeploymentStateContext,
	type DeploymentStateMetadata,
} from "./utils/deploymentState.js"
import { log } from "./utils/log.js"
import { logUpgradeOwnershipSummary } from "./utils/ownership.js"
import { deployAccountLayerDiamond, deployInstantLayer, deploySymbolManager } from "./utils/peripheralHelpers.js"
import { verifyRpc } from "./utils/rpcCheck.js"
import { loadUpgradeConfigShared, resolveConfigFile } from "./utils/sharedConfig.js"

type Config = {
	diamondAddress?: string
	protocolAdmin: string
	symmioFeeReceiver: string
	safeAddress?: string
}

type DeployedState = {
	metadata?: DeploymentStateMetadata
	signatureVerifier?: string
	accountLayer?: any
	instantLayer?: any
	symmioPartyBImplementation?: string
	symbolManager?: { address?: string }
}

const OUTPUT_DIR = "./scripts/upgrade/output"
let STATE_FILE = path.join(OUTPUT_DIR, "deployed-peripherals.json") // updated with network name in main()

function loadConfig(networkName: string): Config {
	const shared = loadUpgradeConfigShared(networkName)
	const configFile = resolveConfigFile("deployPeripherals", networkName, process.env.DEPLOY_PERIPHERALS_CONFIG)
	const raw: Partial<Config> = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf-8")) : {}
	return {
		diamondAddress: raw.diamondAddress ?? shared.diamondAddress,
		protocolAdmin: raw.protocolAdmin ?? shared.protocolAdmin ?? "",
		symmioFeeReceiver: raw.symmioFeeReceiver ?? shared.symmioFeeReceiver ?? "",
		safeAddress: raw.safeAddress ?? shared.safeAddress,
	}
}

function loadState(metadata?: DeploymentStateMetadata): DeployedState {
	if (!fs.existsSync(STATE_FILE)) return {}
	return loadDeploymentState<DeployedState>(STATE_FILE, metadata)
}

function saveState(state: DeployedState, metadata?: DeploymentStateMetadata): void {
	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	saveDeploymentState(STATE_FILE, state, metadata)
}

async function main() {
	const networkName = connection.networkName
	STATE_FILE = path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`)

	const config = loadConfig(networkName)

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
	await verifyRpc()
	const deploymentStateContext: DeploymentStateContext = { networkName, diamondAddress }
	const deploymentMetadata = await resolveDeploymentStateMetadata(deploymentStateContext)
	log.header("Deploy v0.8.5 Peripherals")
	log.kv("Diamond (core)", log.addr(diamondAddress))
	log.kv("Protocol admin", log.addr(protocolAdmin))
	log.kv("Fee receiver", log.addr(symmioFeeReceiver))

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	log.setSteps(5)

	// Deploy MuonSignatureVerifier
	let t = log.step("MuonSignatureVerifier")
	const state0 = loadState(deploymentMetadata)
	let signatureVerifierAddr: string

	if (state0.signatureVerifier) {
		signatureVerifierAddr = state0.signatureVerifier
		log.deployed("MuonSignatureVerifier", signatureVerifierAddr, true)
	} else {
		const factory = await ethers.getContractFactory("MuonSignatureVerifier")
		const contract = await factory.deploy(protocolAdmin)
		signatureVerifierAddr = await contract.getAddress()
		state0.signatureVerifier = signatureVerifierAddr
		saveState(state0, deploymentMetadata)
		await contract.waitForDeployment()
		log.deployed("MuonSignatureVerifier", signatureVerifierAddr)
	}

	// Write address back to upgrade config
	const upgradeConfigPath = resolveConfigFile("upgrade", networkName, process.env.UPGRADE_CONFIG_FILE)
	if (fs.existsSync(upgradeConfigPath)) {
		const upgradeConfig = JSON.parse(fs.readFileSync(upgradeConfigPath, "utf-8"))
		if (!upgradeConfig.newV085Parameters) upgradeConfig.newV085Parameters = {}
		upgradeConfig.newV085Parameters.signatureVerifierAddress = signatureVerifierAddr
		fs.writeFileSync(upgradeConfigPath, JSON.stringify(upgradeConfig, null, "\t") + "\n")
		log.kv("Written signatureVerifierAddress to", upgradeConfigPath)
	}
	log.stepDone(t)

	// Deploy AccountLayer Diamond
	t = log.step("AccountLayer Diamond")
	const alResult = await deployAccountLayerDiamond(protocolAdmin, symmioFeeReceiver, STATE_FILE, undefined, deploymentStateContext)

	// Transfer AccountLayer ownership to Safe (two-step: Safe must call acceptOwnership)
	const AL_NEW_OWNER = process.env.SAFE_ADDRESS ?? config.safeAddress
	if (AL_NEW_OWNER && ethers.isAddress(AL_NEW_OWNER)) {
		const alControlFacet = await ethers.getContractAt("contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet", alResult.diamondAddress)
		try {
			await (await alControlFacet.transferOwnership(AL_NEW_OWNER)).wait()
			log.ok(`transferOwnership(${AL_NEW_OWNER}) on AccountLayer — new owner must call acceptOwnership()`)
		} catch (e: any) {
			// May fail if already transferred or caller is not the owner (e.g. re-run after ownership was already transferred)
			log.ok(`transferOwnership skipped (already transferred or caller is not owner)`)
		}
	}
	log.stepDone(t)

	// Deploy InstantLayer
	t = log.step("InstantLayer")
	const ilResult = await deployInstantLayer(diamondAddress, protocolAdmin, STATE_FILE, deploymentStateContext)
	log.stepDone(t)

	// Deploy SymmioPartyB implementation
	t = log.step("SymmioPartyB Implementation")
	const state = loadState(deploymentMetadata)
	let symmioPartyBImpl: string

	if (state.symmioPartyBImplementation) {
		symmioPartyBImpl = state.symmioPartyBImplementation
		log.deployed("SymmioPartyB", symmioPartyBImpl, true)
	} else {
		const factory = await ethers.getContractFactory("SymmioPartyB")
		const contract = await factory.deploy()
		symmioPartyBImpl = await contract.getAddress()
		state.symmioPartyBImplementation = symmioPartyBImpl
		saveState(state, deploymentMetadata)
		await contract.waitForDeployment()
		log.deployed("SymmioPartyB", symmioPartyBImpl)
	}
	log.stepDone(t)

	// Deploy SymmioSymbolManager
	t = log.step("SymmioSymbolManager")
	const smResult = await deploySymbolManager(diamondAddress, protocolAdmin, STATE_FILE, deploymentStateContext)
	log.stepDone(t)

	await logUpgradeOwnershipSummary({
		symmioCore: diamondAddress,
		accountLayer: alResult.diamondAddress,
		instantLayer: ilResult.address,
		signatureVerifier: signatureVerifierAddr,
		symbolManager: smResult.address,
		symmioPartyBImplementation: symmioPartyBImpl,
		knownAccounts: [
			{ label: "protocolAdmin", address: protocolAdmin },
			{ label: "safe", address: config.safeAddress },
			{ label: "symmioFeeReceiver", address: symmioFeeReceiver },
		],
	})

	// Summary
	log.success("Peripheral deployment complete", [
		["MuonSignatureVerifier", signatureVerifierAddr],
		["AccountLayer Diamond", alResult.diamondAddress],
		["InstantLayer", ilResult.address],
		["SymmioPartyB impl", symmioPartyBImpl],
		["SymmioSymbolManager", smResult.address],
		["State file", STATE_FILE],
	])

	log.nextSteps([`Run generateSafeBatch.ts (peripheral addresses are auto-loaded from ${path.basename(STATE_FILE)})`])
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
