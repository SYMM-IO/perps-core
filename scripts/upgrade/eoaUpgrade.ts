/**
 * EOA Upgrade Script — deploy facets, apply diamond cut, set parameters.
 *
 * Runs the full v0.8.4 -> v0.8.5 upgrade from the connected EOA signer by default.
 * Use UPGRADE_STAGES to run a subset, e.g.:
 *   UPGRADE_STAGES=deploy,pause,cut,wiring npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti
 *
 * Migration is a separate step — run prepareMigrationInput.ts then
 * runMigration.ts after this completes.
 *
 * Stages:
 *   deploy        Alias for facets + peripherals
 *   facets        Deploy v0.8.5 core facets + libraries
 *   peripherals   Deploy verifier, AccountLayer, InstantLayer, PartyB impl, SymbolManager
 *   pause         Grant pause roles and pause the system
 *   cut           Build and apply the diamond cut
 *   params        Set new v0.8.5 parameters
 *   wiring        Wire AccountLayer/InstantLayer/templates/SymbolManager roles
 *   partyb        Register PartyBs from partyBList config
 *   migration     Grant MIGRATION_ROLE
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/eoaUpgrade.ts --network localhost
 *   npx hardhat run scripts/upgrade/eoaUpgrade.ts --network arbitrum
 *   UPGRADE_STAGES=deploy,pause,cut,wiring npx hardhat run scripts/upgrade/eoaUpgrade.ts --network coti
 *
 * Config: scripts/upgrade/config/upgrade.json
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
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { logUpgradeOwnershipSummary } from "./utils/ownership.js"
import {
	deployAccountLayerDiamond,
	deployInstantLayer,
	deploySymbolManager,
	wireAccountLayerInstantLayer,
	wireSymbolManager,
	setupInstantLayerTemplates,
} from "./utils/peripheralHelpers.js"
import { runPreflight } from "./utils/preflight.js"
import { resolveConfigFile } from "./utils/sharedConfig.js"
import {
	deployFacets,
	buildDiamondCut,
	applyDiamondCut,
	setV085Parameters,
	loadDeployedFacets,
	type FacetInfo,
	type NewV085Parameters,
} from "./utils/upgradeHelpers.js"

type Config = {
	diamondAddress?: string
	protocolAdmin?: string
	migrationRunner?: string
	symmioFeeReceiver?: string
	safeAddress?: string
	diamondCutChunkSize?: number
	setupInstantLayerTemplates?: boolean
	stages?: string[] | string
	newV085Parameters?: NewV085Parameters
}

const OUTPUT_DIR = "./scripts/upgrade/output"
const FULL_STAGE_ORDER = ["facets", "peripherals", "pause", "cut", "params", "wiring", "partyb", "migration"] as const
type UpgradeStage = (typeof FULL_STAGE_ORDER)[number]

type PeripheralsState = {
	metadata?: DeploymentStateMetadata
	signatureVerifier?: string
	accountLayer?: { diamond?: string }
	instantLayer?: { address?: string }
	symmioPartyBImplementation?: string
	symbolManager?: { address?: string }
}

type PeripheralsAddresses = {
	signatureVerifier?: string
	accountLayer?: string
	instantLayer?: string
	symbolManager?: string
	symmioPartyBImplementation?: string
}

function loadConfig(): Config {
	const CONFIG_FILE = resolveConfigFile("upgrade", connection.networkName, process.env.UPGRADE_CONFIG_FILE)
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

function parseStageList(config: Config): Set<UpgradeStage> {
	const raw = process.env.UPGRADE_STAGES ?? process.env.EOA_UPGRADE_STAGES ?? config.stages
	if (!raw || (Array.isArray(raw) && raw.length === 0)) return new Set(FULL_STAGE_ORDER)

	const tokens = (Array.isArray(raw) ? raw : raw.split(",")).map(s => s.trim().toLowerCase()).filter(Boolean)

	const stages = new Set<UpgradeStage>()
	const add = (...items: UpgradeStage[]) => {
		for (const item of items) stages.add(item)
	}

	for (const token of tokens) {
		switch (token) {
			case "all":
			case "full":
			case "default":
				return new Set(FULL_STAGE_ORDER)
			case "deploy":
				add("facets", "peripherals")
				break
			case "facet":
			case "facets":
			case "deploy-facets":
				add("facets")
				break
			case "peripheral":
			case "peripherals":
			case "deploy-peripherals":
				add("peripherals")
				break
			case "pause":
				add("pause")
				break
			case "cut":
			case "diamond-cut":
			case "diamondcut":
			case "apply-cut":
			case "apply-diamond-cut":
				add("cut")
				break
			case "param":
			case "params":
			case "parameters":
				add("params")
				break
			case "wire":
			case "wiring":
				add("wiring")
				break
			case "party-b":
			case "partyb":
			case "register-partyb":
			case "register-partybs":
				add("partyb")
				break
			case "migration":
			case "migration-role":
			case "grant-migration-role":
				add("migration")
				break
			default:
				throw new Error(`Unknown UPGRADE_STAGES token "${token}". Valid stages: ${FULL_STAGE_ORDER.join(", ")} plus alias "deploy".`)
		}
	}

	return stages
}

function stageNames(stages: Set<UpgradeStage>): string {
	return FULL_STAGE_ORDER.filter(stage => stages.has(stage)).join(", ")
}

function normalizeSignatureVerifierParam(
	stages: Set<UpgradeStage>,
	newParams: NewV085Parameters,
	peripheralsStateFile: string,
	stateContext: DeploymentStateContext,
): void {
	const configured = newParams.signatureVerifierAddress
	if (configured && ethers.isAddress(configured)) return

	const deployedVerifier = readPeripheralsAddresses(peripheralsStateFile, stateContext).signatureVerifier
	if (stages.has("params") && deployedVerifier) {
		newParams.signatureVerifierAddress = deployedVerifier
		return
	}

	if (!configured) return

	if (stages.has("params") && !stages.has("peripherals")) {
		throw new Error(`newV085Parameters.signatureVerifierAddress is invalid: ${configured}`)
	}

	// The deploy/peripherals stage will deploy a verifier and fill this value in
	// memory. For non-params partial runs, ignore placeholder config values.
	newParams.signatureVerifierAddress = undefined
}

function loadPeripheralsState(stateFile: string, stateContext?: DeploymentStateContext): PeripheralsState {
	if (!fs.existsSync(stateFile)) return {}
	return loadDeploymentState<PeripheralsState>(stateFile, stateContext)
}

function savePeripheralsState(stateFile: string, state: PeripheralsState, metadata?: DeploymentStateMetadata): void {
	const dir = path.dirname(stateFile)
	if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	saveDeploymentState(stateFile, state, metadata)
}

function readPeripheralsAddresses(stateFile: string, stateContext?: DeploymentStateContext): PeripheralsAddresses {
	const state = loadPeripheralsState(stateFile, stateContext)
	return {
		signatureVerifier: state.signatureVerifier,
		accountLayer: state.accountLayer?.diamond,
		instantLayer: state.instantLayer?.address,
		symbolManager: state.symbolManager?.address,
		symmioPartyBImplementation: state.symmioPartyBImplementation,
	}
}

function requirePeripheralAddresses(
	stateFile: string,
	required: Array<keyof PeripheralsAddresses>,
	stateContext?: DeploymentStateContext,
): PeripheralsAddresses {
	const addresses = readPeripheralsAddresses(stateFile, stateContext)
	const missing = required.filter(key => !addresses[key])
	if (missing.length > 0) {
		throw new Error(
			`Missing deployed peripheral address(es): ${missing.join(", ")}. Run UPGRADE_STAGES=peripherals first, or set ${stateFile} from a prior deployment.`,
		)
	}
	return addresses
}

async function resolveUpgradeSigner(config: Config) {
	const protocolAdminAddress = config.protocolAdmin
	if (!protocolAdminAddress) return ethers.provider.getSigner()

	return resolveConfiguredSigner({
		role: "protocolAdmin",
		expectedAddress: protocolAdminAddress,
		envPrefix: "PROTOCOL_ADMIN",
	})
}

async function deploySignatureVerifier(
	protocolAdmin: string,
	stateFile: string,
	configuredAddress?: string,
	stateContext?: DeploymentStateContext,
): Promise<string> {
	if (configuredAddress && ethers.isAddress(configuredAddress)) {
		log.deployed("MuonSignatureVerifier", configuredAddress, true)
		return configuredAddress
	}

	const metadata = await resolveDeploymentStateMetadata(stateContext)
	const state = loadPeripheralsState(stateFile, stateContext)
	if (state.signatureVerifier) {
		log.deployed("MuonSignatureVerifier", state.signatureVerifier, true)
		return state.signatureVerifier
	}

	const factory = await ethers.getContractFactory("MuonSignatureVerifier")
	const contract = await factory.deploy(protocolAdmin)
	const address = await contract.getAddress()
	state.signatureVerifier = address
	savePeripheralsState(stateFile, state, metadata)
	await contract.waitForDeployment()
	log.deployed("MuonSignatureVerifier", address)
	return address
}

async function deploySymmioPartyBImplementation(stateFile: string, stateContext?: DeploymentStateContext): Promise<string> {
	const metadata = await resolveDeploymentStateMetadata(stateContext)
	const state = loadPeripheralsState(stateFile, stateContext)
	if (state.symmioPartyBImplementation) {
		log.deployed("SymmioPartyB", state.symmioPartyBImplementation, true)
		return state.symmioPartyBImplementation
	}

	const factory = await ethers.getContractFactory("SymmioPartyB")
	const contract = await factory.deploy()
	const address = await contract.getAddress()
	state.symmioPartyBImplementation = address
	savePeripheralsState(stateFile, state, metadata)
	await contract.waitForDeployment()
	log.deployed("SymmioPartyB", address)
	return address
}

async function pauseSystem(diamondAddress: string, signer: any): Promise<void> {
	const signerAddress = await signer.getAddress()
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress, signer)
	await (await controlFacet.setAdmin(signerAddress)).wait()
	log.ok("Admin set")
	await (await controlFacet.grantRole(signerAddress, ethers.id("PAUSER_ROLE"))).wait()
	log.ok("PAUSER_ROLE granted")
	await (await controlFacet.grantRole(signerAddress, ethers.id("UNPAUSER_ROLE"))).wait()
	log.ok("UNPAUSER_ROLE granted")

	const pauseHelper = new ethers.Contract(
		diamondAddress,
		["function pauseState() view returns (bool globalPaused, bool, bool, bool, bool, bool, bool)", "function pauseGlobal() external"],
		signer,
	)
	const pauseResult = await pauseHelper.pauseState()
	if (!pauseResult.globalPaused) {
		await (await pauseHelper.pauseGlobal()).wait()
		log.ok("System paused (pauseGlobal)")
	} else {
		log.ok("System already paused")
	}
}

async function registerPartyBs(diamondAddress: string, instantLayerAddress: string | undefined, signer: any): Promise<void> {
	const signerAddress = await signer.getAddress()
	const PARTYB_LIST_FILE = resolveConfigFile("partyBList", connection.networkName, process.env.PARTYB_LIST_FILE)
	if (!fs.existsSync(PARTYB_LIST_FILE)) {
		log.warn(`${PARTYB_LIST_FILE} not found — skipping PartyB registration`)
		return
	}

	const listConfig = JSON.parse(fs.readFileSync(PARTYB_LIST_FILE, "utf-8")) as {
		partyBs?: Record<string, string[]>
		registerOnSymmioCore?: boolean
		registerOnInstantLayer?: boolean
	}
	const partyBsToRegister = Object.values(listConfig.partyBs ?? {})
		.flat()
		.filter(a => ethers.isAddress(a))
	const registerOnSymmioCore = listConfig.registerOnSymmioCore !== false

	if (partyBsToRegister.length > 0 && registerOnSymmioCore) {
		const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress, signer)
		await (await controlFacet.grantRole(signerAddress, ethers.id("PARTY_B_MANAGER_ROLE"))).wait()
		log.ok("PARTY_B_MANAGER_ROLE granted")
		const viewFacet = new ethers.Contract(diamondAddress, ["function isPartyB(address user) view returns (bool)"], signer)
		for (const partyB of partyBsToRegister) {
			const isRegistered: boolean = await viewFacet.isPartyB(partyB)
			if (!isRegistered) {
				await (await controlFacet.registerPartyB(partyB)).wait()
				log.ok(`Registered ${log.addr(partyB)} on Diamond`)
			} else {
				log.ok(`${log.addr(partyB)} already registered on Diamond`)
			}
		}
	} else if (!registerOnSymmioCore) {
		log.ok("registerOnSymmioCore is false — skipping Diamond registration")
	}

	if (listConfig.registerOnInstantLayer) {
		if (!instantLayerAddress) {
			throw new Error("registerOnInstantLayer is true, but no InstantLayer address is available. Run UPGRADE_STAGES=peripherals first.")
		}
		const il = await ethers.getContractAt("InstantLayer", instantLayerAddress, signer)
		for (const partyB of partyBsToRegister) {
			const isRegistered = await il.registeredPartyBs(partyB)
			if (!isRegistered) {
				await (await il.registerPartyBs([partyB])).wait()
				log.ok(`Registered ${log.addr(partyB)} on InstantLayer`)
			} else {
				log.ok(`${log.addr(partyB)} already registered on InstantLayer`)
			}
		}
	} else {
		log.ok("registerOnInstantLayer is false — skipping IL registration")
	}
}

async function main() {
	const scriptTimer = log.timer()
	const config = loadConfig()
	const stages = parseStageList(config)
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const MIGRATION_RUNNER = config.migrationRunner ?? config.protocolAdmin
	const newParams = config.newV085Parameters ?? {}
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const networkName = connection.networkName
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const facetsOutFile = process.env.FACETS_FILE ?? path.join(OUTPUT_DIR, `deployed-facets-${networkName}.json`)
	const peripheralsStateFile = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`)
	const deploymentStateContext = { networkName, chainId, diamondAddress: DIAMOND_ADDRESS }
	normalizeSignatureVerifierParam(stages, newParams, peripheralsStateFile, deploymentStateContext)

	// Preflight — fail early with a clear message before any on-chain side effects.
	await runPreflight(connection.networkName, {
		diamondAddress: DIAMOND_ADDRESS,
		signatureVerifierAddress: newParams.signatureVerifierAddress,
		stateFiles: [facetsOutFile, peripheralsStateFile],
	})

	log.header("Symmio v0.8.5 EOA Upgrade")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Stages", stageNames(stages))
	log.kv("Diamond cut chunk size", String(DIAMOND_CUT_CHUNK_SIZE))

	const signer = await resolveUpgradeSigner(config)
	const signerAddress = await signer.getAddress()

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

	log.setSteps(stages.size + (stages.has("cut") ? 1 : 0))

	let newFacets: Record<string, FacetInfo> | undefined
	let selectorSignatures: Record<string, string> | undefined
	let diamondCut: any[] | undefined
	let peripherals: PeripheralsAddresses = readPeripheralsAddresses(peripheralsStateFile, deploymentStateContext)

	if (stages.has("facets")) {
		const t = log.step("Deploy v0.8.5 facets")
		const deployed = await deployFacets(facetsOutFile, deploymentStateContext)
		newFacets = deployed.facets
		selectorSignatures = deployed.selectorSignatures
		log.ok(`${Object.keys(newFacets).length} facets ready`)
		log.stepDone(t)
	}

	if (stages.has("peripherals")) {
		const t = log.step("Deploy peripherals")
		const symmioFeeReceiver = config.symmioFeeReceiver || signerAddress
		const signatureVerifier = await deploySignatureVerifier(
			signerAddress,
			peripheralsStateFile,
			newParams.signatureVerifierAddress,
			deploymentStateContext,
		)
		if (!newParams.signatureVerifierAddress || !ethers.isAddress(newParams.signatureVerifierAddress)) {
			newParams.signatureVerifierAddress = signatureVerifier
		}
		const alResult = await deployAccountLayerDiamond(signerAddress, symmioFeeReceiver, peripheralsStateFile, signer, deploymentStateContext)
		const ilResult = await deployInstantLayer(DIAMOND_ADDRESS, signerAddress, peripheralsStateFile, deploymentStateContext)
		await deploySymmioPartyBImplementation(peripheralsStateFile, deploymentStateContext)
		const smResult = await deploySymbolManager(DIAMOND_ADDRESS, signerAddress, peripheralsStateFile, deploymentStateContext)
		peripherals = {
			signatureVerifier,
			accountLayer: alResult.diamondAddress,
			instantLayer: ilResult.address,
			symbolManager: smResult.address,
		}
		log.stepDone(t)
	}

	const needsDiamondCut = stages.has("cut")
	if (needsDiamondCut) {
		const t = log.step("Build diamond cut")
		if (!newFacets || !selectorSignatures) {
			const loaded = loadDeployedFacets(facetsOutFile, deploymentStateContext)
			newFacets = loaded.facets
			selectorSignatures = loaded.selectorSignatures
		}
		const built = await buildDiamondCut(DIAMOND_ADDRESS, newFacets, selectorSignatures)
		diamondCut = built.diamondCut
		const counts = { add: 0, replace: 0, remove: 0 }
		for (const c of built.selectorChanges) counts[c.action]++
		log.info("Selector changes:")
		log.stats([
			["Add", counts.add],
			["Replace", counts.replace],
			["Remove", counts.remove],
			["Total", built.selectorChanges.length],
		])
		if (diamondCut.length === 0) {
			log.ok("Nothing to cut — diamond is already up to date")
		}
		log.stepDone(t)
	}

	if (stages.has("pause")) {
		const t = log.step("Pause system")
		await pauseSystem(DIAMOND_ADDRESS, signer)
		log.stepDone(t)
	}

	if (stages.has("cut")) {
		const t = log.step("Apply diamond cut")
		if (!diamondCut) throw new Error("Internal error: diamond cut was not built")
		if (diamondCut.length > 0) {
			await applyDiamondCut(DIAMOND_ADDRESS, diamondCut, signer, DIAMOND_CUT_CHUNK_SIZE)
			log.ok("Diamond cut applied")
		}
		log.stepDone(t)
	}

	if (stages.has("params")) {
		const t = log.step("Set v0.8.5 parameters")
		if (Object.keys(newParams).length > 0) {
			await setV085Parameters(DIAMOND_ADDRESS, newParams, signer)
		} else {
			log.info("(no parameters configured)")
		}
		log.stepDone(t)
	}

	if (stages.has("wiring")) {
		const t = log.step("Wire peripherals")
		peripherals = {
			...peripherals,
			...requirePeripheralAddresses(peripheralsStateFile, ["accountLayer", "instantLayer", "symbolManager"], deploymentStateContext),
		}
		await wireAccountLayerInstantLayer(DIAMOND_ADDRESS, peripherals.accountLayer!, peripherals.instantLayer!, signer)
		if (config.setupInstantLayerTemplates !== false) {
			await setupInstantLayerTemplates(peripherals.instantLayer!, signer)
		}
		await wireSymbolManager(DIAMOND_ADDRESS, peripherals.symbolManager!, signer)
		log.stepDone(t)
	}

	if (stages.has("partyb")) {
		const t = log.step("Deploy SymmioPartyB + register PartyBs")
		await deploySymmioPartyBImplementation(peripheralsStateFile, deploymentStateContext)
		peripherals = { ...peripherals, ...readPeripheralsAddresses(peripheralsStateFile, deploymentStateContext) }
		await registerPartyBs(DIAMOND_ADDRESS, peripherals.instantLayer, signer)
		log.stepDone(t)
	}

	if (stages.has("migration")) {
		const t = log.step("Grant migration role")
		if (MIGRATION_RUNNER) {
			const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", DIAMOND_ADDRESS, signer)
			await (await controlFacet.grantRole(MIGRATION_RUNNER, ethers.id("MIGRATION_ROLE"))).wait()
			log.ok(`MIGRATION_ROLE granted to ${log.addr(MIGRATION_RUNNER)}`)
		} else {
			log.warn("No migration runner configured — skipping")
		}
		log.stepDone(t)
	}

	peripherals = { ...peripherals, ...readPeripheralsAddresses(peripheralsStateFile, deploymentStateContext) }
	await logUpgradeOwnershipSummary({
		symmioCore: DIAMOND_ADDRESS,
		accountLayer: peripherals.accountLayer,
		instantLayer: peripherals.instantLayer,
		signatureVerifier: peripherals.signatureVerifier ?? newParams.signatureVerifierAddress,
		symbolManager: peripherals.symbolManager,
		symmioPartyBImplementation: peripherals.symmioPartyBImplementation,
		knownAccounts: [
			{ label: "signer", address: signerAddress },
			{ label: "protocolAdmin", address: config.protocolAdmin },
			{ label: "safe", address: config.safeAddress },
			{ label: "migrationRunner", address: MIGRATION_RUNNER },
			{ label: "symmioFeeReceiver", address: config.symmioFeeReceiver },
		],
	})
	log.success("EOA upgrade completed successfully", [
		["Diamond", DIAMOND_ADDRESS],
		["Stages", stageNames(stages)],
		["AccountLayer", peripherals.accountLayer ?? "(not deployed in this run)"],
		["InstantLayer", peripherals.instantLayer ?? "(not deployed in this run)"],
		["SymbolManager", peripherals.symbolManager ?? "(not deployed in this run)"],
		["Duration", scriptTimer.fmt()],
	])

	if (stages.has("migration")) {
		log.nextSteps([
			"Run prepareMigrationInput.ts to fetch + validate migration data",
			"Run runMigration.ts with the validated input file",
			"Unpause the system after migration is complete",
		])
	}
}

main().catch(error => {
	console.error(error)
	process.exitCode = 1
})
