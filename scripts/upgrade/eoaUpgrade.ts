/**
 * EOA Upgrade Script — deploy facets, apply diamond cut, set parameters.
 *
 * Plans the v0.8.4 -> v0.8.5 upgrade by default. Execution requires
 * EXECUTE=true plus a chain-id confirmation.
 * Use UPGRADE_STAGES to run a subset, e.g.:
 *   UPGRADE_STAGES=deploy,pause,cut,wiring ./node_modules/.bin/hardhat run scripts/upgrade/eoaUpgrade.ts --network coti
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
 *   cross-mode    Enable global cross-PartyB mode (migrationRunner signer)
 *   cross-partyb  Enable cross mode for configured PartyBs (migrationRunner signer)
 *   migration-revoke Revoke MIGRATION_ROLE from migrationRunner
 *   symbol-revoke Revoke SYMBOL_MANAGER_ROLE from migrationRunner
 *   unpause       Unpause the system
 *   operator-grant Grant temporary operator roles (protocolAdmin signer)
 *   operator-revoke Revoke temporary non-admin operator roles (upgradeOperator signer)
 *   operator-admin-revoke Revoke temporary DEFAULT_ADMIN_ROLE grants (protocolAdmin signer)
 *
 * Plan:
 *   UPGRADE_STAGES=deploy,pause,cut,wiring ./node_modules/.bin/hardhat run scripts/upgrade/eoaUpgrade.ts --network coti
 * Execute:
 *   EXECUTE=true CONFIRM_CHAIN_ID=2632500 UPGRADE_STAGES=deploy,pause,cut,wiring \
 *     ./node_modules/.bin/hardhat run scripts/upgrade/eoaUpgrade.ts --network coti
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
import { requireExecutionConfirmation } from "./utils/executionGuard.js"
import { resolveConfiguredSigner } from "./utils/hardwareSigner.js"
import { log } from "./utils/log.js"
import { DIAMOND_OWNER_ABI, logUpgradeOwnershipSummary, readDiamondOwner } from "./utils/ownership.js"
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
import { deployTxOverrides, writeTxOverrides } from "./utils/txOverrides.js"
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
	upgradeOperator?: string
	migrationRunner?: string
	symmioFeeReceiver?: string
	safeAddress?: string
	diamondCutChunkSize?: number
	setupInstantLayerTemplates?: boolean
	stages?: string[] | string
	newV085Parameters?: NewV085Parameters
}

type PostMigrationConfig = {
	diamondAddress?: string
	safeAddress?: string
	migrationRunner?: string
	partyBs?: string[]
}

const OUTPUT_DIR = "./scripts/upgrade/output"
const FULL_STAGE_ORDER = ["facets", "peripherals", "pause", "cut", "params", "wiring", "partyb", "migration"] as const
const POST_MIGRATION_STAGE_ORDER = ["cross-mode", "cross-partyb", "migration-revoke", "symbol-revoke", "unpause"] as const
const OPERATOR_STAGE_ORDER = ["operator-grant", "operator-revoke", "operator-admin-revoke"] as const
const ALL_STAGE_ORDER = [...FULL_STAGE_ORDER, ...POST_MIGRATION_STAGE_ORDER, ...OPERATOR_STAGE_ORDER] as const
type UpgradeStage = (typeof ALL_STAGE_ORDER)[number]
type OperatorRoleStage = (typeof OPERATOR_STAGE_ORDER)[number]
const DEPLOY_ONLY_STAGES = new Set<UpgradeStage>(["facets", "peripherals"])
const MIGRATION_RUNNER_STAGES = new Set<UpgradeStage>(["cross-mode", "cross-partyb"])

const CORE_OPERATOR_GRANT_ROLES = [
	"DEFAULT_ADMIN_ROLE",
	"PAUSER_ROLE",
	"UNPAUSER_ROLE",
	"PROTOCOL_CONFIG_ROLE",
	"COOLDOWN_ADMIN_ROLE",
	"FEE_ADMIN_ROLE",
	"INTEGRATION_ADMIN_ROLE",
	"PARTY_B_MANAGER_ROLE",
] as const
const CORE_OPERATOR_REVOKE_ROLES = [
	"PAUSER_ROLE",
	"UNPAUSER_ROLE",
	"PROTOCOL_CONFIG_ROLE",
	"COOLDOWN_ADMIN_ROLE",
	"FEE_ADMIN_ROLE",
	"INTEGRATION_ADMIN_ROLE",
	"PARTY_B_MANAGER_ROLE",
] as const
const CORE_MIGRATION_RUNNER_ROLES = ["MIGRATION_ROLE", "SYMBOL_MANAGER_ROLE"] as const

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

type OperatorRoleActionStatus = "already-present" | "granted" | "already-absent" | "revoked" | "failed"
type OperatorRoleActionOperation = "grant" | "revoke" | "setAdmin"
type OperatorRoleReportStatus = "running" | "success" | "failed"

type OperatorRoleAction = {
	index: number
	timestamp: string
	stage: OperatorRoleStage
	operation: OperatorRoleActionOperation
	targetLabel: string
	targetAddress: string
	account: string
	roleName: string
	roleHash: string
	status: OperatorRoleActionStatus
	txHash?: string
	blockNumber?: number
	error?: string
}

type OperatorRoleReport = {
	status: OperatorRoleReportStatus
	stage: OperatorRoleStage
	networkName: string
	chainId: number
	diamondAddress: string
	signer: string
	protocolAdmin?: string
	upgradeOperator?: string
	migrationRunner?: string
	startedAt: string
	updatedAt: string
	finishedAt?: string
	outputFile: string
	summary: Record<OperatorRoleActionStatus, number>
	actions: OperatorRoleAction[]
	error?: string
}

function upgradeConfigFile(): string {
	return resolveConfigFile("upgrade", connection.networkName, process.env.UPGRADE_CONFIG_FILE)
}

function loadConfig(): Config {
	const CONFIG_FILE = upgradeConfigFile()
	if (!fs.existsSync(CONFIG_FILE)) return {}
	return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Config
}

function loadPostMigrationConfig(networkName: string): PostMigrationConfig {
	const configFile = resolveConfigFile("postMigration", networkName, process.env.POST_MIGRATION_CONFIG_FILE)
	if (!fs.existsSync(configFile)) return {}
	return JSON.parse(fs.readFileSync(configFile, "utf-8")) as PostMigrationConfig
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
			case "cross-mode":
			case "cross-partyb-mode":
			case "enable-cross-mode":
				add("cross-mode")
				break
			case "cross-partyb":
			case "cross-partybs":
			case "enable-cross-partyb":
			case "enable-cross-partybs":
				add("cross-partyb")
				break
			case "migration-revoke":
			case "revoke-migration":
			case "revoke-migration-role":
				add("migration-revoke")
				break
			case "symbol-revoke":
			case "revoke-symbol":
			case "revoke-symbol-role":
			case "revoke-symbol-manager-role":
				add("symbol-revoke")
				break
			case "unpause":
			case "unpause-global":
				add("unpause")
				break
			case "operator":
			case "operator-grant":
			case "grant-operator":
			case "grant-operator-roles":
				add("operator-grant")
				break
			case "operator-revoke":
			case "revoke-operator":
			case "revoke-operator-roles":
			case "cleanup-operator":
				add("operator-revoke")
				break
			case "operator-admin-revoke":
			case "revoke-operator-admin":
			case "revoke-operator-default-admin":
			case "cleanup-operator-admin":
				add("operator-admin-revoke")
				break
			default:
				throw new Error(`Unknown UPGRADE_STAGES token "${token}". Valid stages: ${ALL_STAGE_ORDER.join(", ")} plus alias "deploy".`)
		}
	}

	return stages
}

function stageNames(stages: Set<UpgradeStage>): string {
	return ALL_STAGE_ORDER.filter(stage => stages.has(stage)).join(", ")
}

function needsProtocolAdminSigner(stages: Set<UpgradeStage>): boolean {
	return [...stages].some(stage => !DEPLOY_ONLY_STAGES.has(stage))
}

function hasOnlyMigrationRunnerStages(stages: Set<UpgradeStage>): boolean {
	return stages.size > 0 && [...stages].every(stage => MIGRATION_RUNNER_STAGES.has(stage))
}

function signerRoleOverride(): "protocolAdmin" | "upgradeOperator" | "migrationRunner" | undefined {
	const raw = process.env.UPGRADE_SIGNER_ROLE ?? process.env.EOA_UPGRADE_SIGNER_ROLE
	if (!raw) return undefined
	const normalized = raw.trim().toLowerCase()
	if (["protocoladmin", "protocol-admin", "admin", "owner"].includes(normalized)) return "protocolAdmin"
	if (["upgradeoperator", "upgrade-operator", "operator"].includes(normalized)) return "upgradeOperator"
	if (["migrationrunner", "migration-runner", "migrator"].includes(normalized)) return "migrationRunner"
	throw new Error(`Invalid UPGRADE_SIGNER_ROLE: ${raw}. Use protocolAdmin, upgradeOperator, or migrationRunner.`)
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

async function requireDeployedCode(label: string, address: string): Promise<void> {
	if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(`${label} has an invalid address: ${address}`)
	if ((await ethers.provider.getCode(address)) === "0x") {
		throw new Error(`${label} has no deployed code at ${address}; reconcile the deployment transaction before resuming`)
	}
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	const temporaryPath = `${filePath}.${process.pid}.tmp`
	fs.writeFileSync(temporaryPath, JSON.stringify(value, null, "\t") + "\n")
	fs.renameSync(temporaryPath, filePath)
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

async function requirePeripheralAddresses(
	stateFile: string,
	required: Array<keyof PeripheralsAddresses>,
	stateContext?: DeploymentStateContext,
): Promise<PeripheralsAddresses> {
	const addresses = readPeripheralsAddresses(stateFile, stateContext)
	const missing = required.filter(key => !addresses[key])
	if (missing.length > 0) {
		throw new Error(
			`Missing deployed peripheral address(es): ${missing.join(", ")}. Run UPGRADE_STAGES=peripherals first, or set ${stateFile} from a prior deployment.`,
		)
	}
	await Promise.all(required.map(key => requireDeployedCode(key, addresses[key]!)))
	return addresses
}

async function resolveUpgradeSigner(config: Config, stages: Set<UpgradeStage>) {
	if (!needsProtocolAdminSigner(stages)) {
		log.info("Deploy-only stages selected; using the default deployer signer.")
		return ethers.provider.getSigner()
	}

	const signerRole = signerRoleOverride()
	if (!signerRole && hasOnlyMigrationRunnerStages(stages)) {
		const migrationRunnerAddress = normalizeOptionalAddress(process.env.MIGRATION_RUNNER ?? config.migrationRunner)
		if (!migrationRunnerAddress) {
			throw new Error("migrationRunner is required for cross-mode/cross-partyb stages.")
		}
		return resolveConfiguredSigner({
			role: "migrationRunner",
			expectedAddress: migrationRunnerAddress,
			envPrefix: "MIGRATION_RUNNER",
		})
	}
	if (signerRole === "migrationRunner") {
		if (!hasOnlyMigrationRunnerStages(stages)) {
			throw new Error("UPGRADE_SIGNER_ROLE=migrationRunner can only run cross-mode/cross-partyb stages.")
		}
		const migrationRunnerAddress = normalizeOptionalAddress(process.env.MIGRATION_RUNNER ?? config.migrationRunner)
		if (!migrationRunnerAddress) {
			throw new Error("migrationRunner is required for UPGRADE_SIGNER_ROLE=migrationRunner.")
		}
		return resolveConfiguredSigner({
			role: "migrationRunner",
			expectedAddress: migrationRunnerAddress,
			envPrefix: "MIGRATION_RUNNER",
		})
	}
	if (signerRole === "upgradeOperator") {
		if (stages.has("cut")) {
			throw new Error("UPGRADE_SIGNER_ROLE=upgradeOperator cannot run the cut stage; diamondCut is owner-only and must be run by protocolAdmin.")
		}
		if (stages.has("operator-grant") || stages.has("operator-admin-revoke")) {
			throw new Error("operator-grant/operator-admin-revoke must be run by protocolAdmin.")
		}
		if ([...stages].some(stage => MIGRATION_RUNNER_STAGES.has(stage))) {
			const migrationRunnerAddress = normalizeOptionalAddress(process.env.MIGRATION_RUNNER ?? config.migrationRunner)
			const operatorAddress = resolveUpgradeOperatorAddress(config)
			if (migrationRunnerAddress && migrationRunnerAddress.toLowerCase() !== operatorAddress.toLowerCase()) {
				throw new Error(
					"cross-mode/cross-partyb stages require UPGRADE_SIGNER_ROLE=migrationRunner when migrationRunner differs from upgradeOperator.",
				)
			}
		}
		const operatorAddress = resolveUpgradeOperatorAddress(config)
		return resolveConfiguredSigner({
			role: "upgradeOperator",
			expectedAddress: operatorAddress,
			envPrefix: "UPGRADE_OPERATOR",
		})
	}

	const protocolAdminAddress = config.protocolAdmin
	if (!protocolAdminAddress) return ethers.provider.getSigner()

	return resolveConfiguredSigner({
		role: "protocolAdmin",
		expectedAddress: protocolAdminAddress,
		envPrefix: "PROTOCOL_ADMIN",
	})
}

function resolveUpgradeOperatorAddress(config: Config): string {
	const raw = process.env.UPGRADE_OPERATOR ?? config.upgradeOperator ?? config.migrationRunner
	if (!raw || !ethers.isAddress(raw)) {
		throw new Error("upgradeOperator is required and must be a valid address (or set UPGRADE_OPERATOR / migrationRunner)")
	}
	return ethers.getAddress(raw)
}

function normalizeOptionalAddress(address: string | undefined): string | undefined {
	if (!address) return undefined
	if (!ethers.isAddress(address)) throw new Error(`Invalid address: ${address}`)
	return ethers.getAddress(address)
}

function parseAddressList(value: string | undefined): string[] {
	if (!value?.trim()) return []
	return value
		.split(",")
		.map(item => item.trim())
		.filter(Boolean)
}

function normalizeAddressList(addresses: string[], label: string): string[] {
	const unique = new Map<string, string>()
	for (const address of addresses) {
		if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
			throw new Error(`Invalid ${label} address: ${address}`)
		}
		const normalized = ethers.getAddress(address)
		unique.set(normalized.toLowerCase(), normalized)
	}
	return [...unique.values()]
}

function resolveMigrationRunnerAddress(config: Config, postMigrationConfig: PostMigrationConfig): string {
	const raw = process.env.MIGRATION_RUNNER ?? postMigrationConfig.migrationRunner ?? config.migrationRunner
	if (!raw || !ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
		throw new Error("migrationRunner is required and must be a valid address.")
	}
	return ethers.getAddress(raw)
}

function resolvePostMigrationPartyBs(postMigrationConfig: PostMigrationConfig): string[] {
	const fromEnv = parseAddressList(process.env.POST_MIGRATION_PARTYBS ?? process.env.CROSS_PARTYBS ?? process.env.PARTYBS)
	const partyBs = fromEnv.length > 0 ? fromEnv : (postMigrationConfig.partyBs ?? [])
	return normalizeAddressList(partyBs, "PartyB")
}

function resolveDeploymentAdmin(config: Config, deployerAddress: string): string {
	if (!config.protocolAdmin) {
		log.warn("protocolAdmin is not configured; deployed peripherals will use the deployer as admin")
		return deployerAddress
	}
	if (!ethers.isAddress(config.protocolAdmin)) {
		throw new Error(`protocolAdmin is invalid: ${config.protocolAdmin}`)
	}
	return ethers.getAddress(config.protocolAdmin)
}

function writeSignatureVerifierToUpgradeConfig(signatureVerifierAddress: string): void {
	if (!ethers.isAddress(signatureVerifierAddress)) return

	const CONFIG_FILE = upgradeConfigFile()
	if (!fs.existsSync(CONFIG_FILE)) {
		log.warn(`Upgrade config not found; cannot write signatureVerifierAddress: ${CONFIG_FILE}`)
		return
	}

	const upgradeConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"))
	if (!upgradeConfig.newV085Parameters) upgradeConfig.newV085Parameters = {}
	const current = upgradeConfig.newV085Parameters.signatureVerifierAddress
	if (current && ethers.isAddress(current) && ethers.getAddress(current) === ethers.getAddress(signatureVerifierAddress)) {
		log.kv("signatureVerifierAddress already in", CONFIG_FILE)
		return
	}

	upgradeConfig.newV085Parameters.signatureVerifierAddress = ethers.getAddress(signatureVerifierAddress)
	writeJsonAtomic(CONFIG_FILE, upgradeConfig)
	log.kv("Written signatureVerifierAddress to", CONFIG_FILE)
}

async function initiateAccountLayerOwnershipTransfer(accountLayerAddress: string, signer: any, newOwner: string): Promise<void> {
	if (!ethers.isAddress(newOwner)) return

	const accountLayer = new ethers.Contract(
		accountLayerAddress,
		[...DIAMOND_OWNER_ABI, "function pendingOwner() view returns (address)", "function transferOwnership(address owner)"],
		signer,
	)
	const [owner, pendingOwner] = await Promise.all([readDiamondOwner(accountLayer), accountLayer.pendingOwner()])
	if (!owner) {
		log.warn(`Could not read AccountLayer owner at ${log.addr(accountLayerAddress)} — skipping ownership transfer`)
		return
	}
	const normalizedNewOwner = ethers.getAddress(newOwner)
	const normalizedOwner = ethers.getAddress(owner)
	const normalizedPendingOwner = ethers.getAddress(pendingOwner)

	if (normalizedOwner.toLowerCase() === normalizedNewOwner.toLowerCase()) {
		log.ok(`AccountLayer owner already ${log.addr(normalizedNewOwner)}`)
		return
	}
	if (normalizedPendingOwner.toLowerCase() === normalizedNewOwner.toLowerCase()) {
		log.ok(`AccountLayer ownership transfer already pending to ${log.addr(normalizedNewOwner)}`)
		return
	}

	const signerAddress = ethers.getAddress(await signer.getAddress())
	if (normalizedOwner.toLowerCase() !== signerAddress.toLowerCase()) {
		throw new Error(
			`Cannot transfer AccountLayer ownership: current owner is ${normalizedOwner}, signer is ${signerAddress}, and pending owner is ${normalizedPendingOwner}`,
		)
	}

	const receipt = await (await accountLayer.transferOwnership(normalizedNewOwner, writeTxOverrides())).wait()
	if (!receipt?.status) throw new Error("AccountLayer transferOwnership transaction failed")
	const verifiedPendingOwner = ethers.getAddress(await accountLayer.pendingOwner())
	if (verifiedPendingOwner !== normalizedNewOwner) {
		throw new Error(`AccountLayer ownership post-state mismatch: pending owner is ${verifiedPendingOwner}, expected ${normalizedNewOwner}`)
	}
	log.ok(`AccountLayer ownership transfer initiated to ${log.addr(normalizedNewOwner)}`)
}

async function deploySignatureVerifier(
	protocolAdmin: string,
	stateFile: string,
	configuredAddress?: string,
	stateContext?: DeploymentStateContext,
): Promise<string> {
	if (configuredAddress && ethers.isAddress(configuredAddress)) {
		await requireDeployedCode("Configured MuonSignatureVerifier", configuredAddress)
		log.deployed("MuonSignatureVerifier", configuredAddress, true)
		return configuredAddress
	}

	const metadata = await resolveDeploymentStateMetadata(stateContext)
	const state = loadPeripheralsState(stateFile, stateContext)
	if (state.signatureVerifier) {
		await requireDeployedCode("MuonSignatureVerifier", state.signatureVerifier)
		log.deployed("MuonSignatureVerifier", state.signatureVerifier, true)
		return state.signatureVerifier
	}

	const factory = await ethers.getContractFactory("MuonSignatureVerifier")
	const contract = await factory.deploy(protocolAdmin, deployTxOverrides())
	const address = await contract.getAddress()
	await contract.waitForDeployment()
	await requireDeployedCode("MuonSignatureVerifier", address)
	state.signatureVerifier = address
	savePeripheralsState(stateFile, state, metadata)
	log.deployed("MuonSignatureVerifier", address)
	return address
}

async function deploySymmioPartyBImplementation(stateFile: string, stateContext?: DeploymentStateContext): Promise<string> {
	const metadata = await resolveDeploymentStateMetadata(stateContext)
	const state = loadPeripheralsState(stateFile, stateContext)
	if (state.symmioPartyBImplementation) {
		await requireDeployedCode("SymmioPartyB", state.symmioPartyBImplementation)
		log.deployed("SymmioPartyB", state.symmioPartyBImplementation, true)
		return state.symmioPartyBImplementation
	}

	const factory = await ethers.getContractFactory("SymmioPartyB")
	const contract = await factory.deploy(deployTxOverrides())
	const address = await contract.getAddress()
	await contract.waitForDeployment()
	await requireDeployedCode("SymmioPartyB", address)
	state.symmioPartyBImplementation = address
	savePeripheralsState(stateFile, state, metadata)
	log.deployed("SymmioPartyB", address)
	return address
}

const CORE_ACCESS_ABI = [
	...DIAMOND_OWNER_ABI,
	"function hasRole(address user, bytes32 role) view returns (bool)",
	"function isRoleAdmin(address user, bytes32 role) view returns (bool)",
	"function setAdmin(address user)",
	"function grantRole(address user, bytes32 role)",
	"function revokeRole(address user, bytes32 role)",
]

const ACCOUNT_LAYER_ACCESS_ABI = [
	"function hasRole(address user, bytes32 role) view returns (bool)",
	"function grantRole(address user, bytes32 role)",
	"function revokeRole(address user, bytes32 role)",
]

const STANDARD_ACCESS_ABI = [
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function grantRole(bytes32 role, address account)",
	"function revokeRole(bytes32 role, address account)",
	"function renounceRole(bytes32 role, address account)",
]

function emptyOperatorRoleSummary(): Record<OperatorRoleActionStatus, number> {
	return {
		"already-present": 0,
		granted: 0,
		"already-absent": 0,
		revoked: 0,
		failed: 0,
	}
}

function createOperatorRoleReport(
	stage: OperatorRoleStage,
	networkName: string,
	chainId: number,
	diamondAddress: string,
	signer: string,
	config: Config,
	migrationRunner: string | undefined,
): OperatorRoleReport {
	const outputFile = path.join(OUTPUT_DIR, `${stage}-report-${networkName}.json`)
	const upgradeOperator = process.env.UPGRADE_OPERATOR ?? config.upgradeOperator ?? config.migrationRunner
	return {
		status: "running",
		stage,
		networkName,
		chainId,
		diamondAddress: ethers.getAddress(diamondAddress),
		signer: ethers.getAddress(signer),
		protocolAdmin: normalizeOptionalAddress(config.protocolAdmin),
		upgradeOperator: normalizeOptionalAddress(upgradeOperator),
		migrationRunner: normalizeOptionalAddress(migrationRunner),
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		outputFile,
		summary: emptyOperatorRoleSummary(),
		actions: [],
	}
}

function writeOperatorRoleReport(report: OperatorRoleReport): void {
	report.updatedAt = new Date().toISOString()
	report.summary = emptyOperatorRoleSummary()
	for (const action of report.actions) report.summary[action.status]++
	const dir = path.dirname(report.outputFile)
	if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(report.outputFile, JSON.stringify(report, null, 2))
}

function recordOperatorRoleAction(report: OperatorRoleReport | undefined, action: Omit<OperatorRoleAction, "index" | "timestamp" | "stage">): void {
	if (!report) return
	report.actions.push({
		index: report.actions.length + 1,
		timestamp: new Date().toISOString(),
		stage: report.stage,
		...action,
	})
	writeOperatorRoleReport(report)
}

function finishOperatorRoleReport(report: OperatorRoleReport, status: Exclude<OperatorRoleReportStatus, "running">, error?: unknown): void {
	report.status = status
	report.finishedAt = new Date().toISOString()
	if (error !== undefined) report.error = errorMessage(error)
	writeOperatorRoleReport(report)
}

function roleHash(roleName: string): string {
	return ethers.id(roleName)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function grantCoreRoleIfMissing(
	controlFacet: any,
	targetAddress: string,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const role = ethers.id(roleName)
	if (await controlFacet.hasRole(account, role)) {
		log.ok(`${roleName} already granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-present",
		})
		return
	}
	try {
		const tx = await controlFacet.grantRole(account, role, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`${roleName} granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "granted",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function revokeCoreRoleIfPresent(
	controlFacet: any,
	targetAddress: string,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const role = ethers.id(roleName)
	if (!(await controlFacet.hasRole(account, role))) {
		log.ok(`${roleName} already absent from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-absent",
		})
		return
	}
	try {
		const tx = await controlFacet.revokeRole(account, role, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`${roleName} revoked from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "revoked",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function grantCoreDefaultAdminIfMissing(controlFacet: any, targetAddress: string, account: string, report?: OperatorRoleReport): Promise<void> {
	const roleName = "DEFAULT_ADMIN_ROLE"
	const role = roleHash(roleName)
	if (await controlFacet.hasRole(account, role)) {
		log.ok(`DEFAULT_ADMIN_ROLE already granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "setAdmin",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-present",
		})
		return
	}
	try {
		const tx = await controlFacet.setAdmin(account, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`DEFAULT_ADMIN_ROLE granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "setAdmin",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "granted",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "setAdmin",
			targetLabel: "Symmio Core Diamond",
			targetAddress,
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function grantAccountLayerRoleIfMissing(
	accountLayerAddress: string,
	signer: any,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const contract = new ethers.Contract(accountLayerAddress, ACCOUNT_LAYER_ACCESS_ABI, signer)
	const role = roleHash(roleName)
	if (await contract.hasRole(account, role)) {
		log.ok(`AccountLayer ${roleName} already granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: "AccountLayer",
			targetAddress: ethers.getAddress(accountLayerAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-present",
		})
		return
	}
	try {
		const tx = await contract.grantRole(account, role, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`AccountLayer ${roleName} granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: "AccountLayer",
			targetAddress: ethers.getAddress(accountLayerAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "granted",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: "AccountLayer",
			targetAddress: ethers.getAddress(accountLayerAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function revokeAccountLayerRoleIfPresent(
	accountLayerAddress: string,
	signer: any,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const contract = new ethers.Contract(accountLayerAddress, ACCOUNT_LAYER_ACCESS_ABI, signer)
	const role = roleHash(roleName)
	if (!(await contract.hasRole(account, role))) {
		log.ok(`AccountLayer ${roleName} already absent from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: "AccountLayer",
			targetAddress: ethers.getAddress(accountLayerAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-absent",
		})
		return
	}
	try {
		const tx = await contract.revokeRole(account, role, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`AccountLayer ${roleName} revoked from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: "AccountLayer",
			targetAddress: ethers.getAddress(accountLayerAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "revoked",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: "AccountLayer",
			targetAddress: ethers.getAddress(accountLayerAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function grantStandardRoleIfMissing(
	contractAddress: string,
	signer: any,
	label: string,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const contract = new ethers.Contract(contractAddress, STANDARD_ACCESS_ABI, signer)
	const role = roleHash(roleName)
	if (await contract.hasRole(role, account)) {
		log.ok(`${label} ${roleName} already granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-present",
		})
		return
	}
	try {
		const tx = await contract.grantRole(role, account, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`${label} ${roleName} granted to ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "granted",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "grant",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function revokeStandardRoleIfPresent(
	contractAddress: string,
	signer: any,
	label: string,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const contract = new ethers.Contract(contractAddress, STANDARD_ACCESS_ABI, signer)
	const role = roleHash(roleName)
	if (!(await contract.hasRole(role, account))) {
		log.ok(`${label} ${roleName} already absent from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-absent",
		})
		return
	}
	try {
		const tx = await contract.revokeRole(role, account, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`${label} ${roleName} revoked from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "revoked",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function renounceStandardRoleIfPresent(
	contractAddress: string,
	signer: any,
	label: string,
	account: string,
	roleName: string,
	report?: OperatorRoleReport,
): Promise<void> {
	const contract = new ethers.Contract(contractAddress, STANDARD_ACCESS_ABI, signer)
	const role = roleHash(roleName)
	if (!(await contract.hasRole(role, account))) {
		log.ok(`${label} ${roleName} already absent from ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "already-absent",
		})
		return
	}
	try {
		const tx = await contract.renounceRole(role, account, writeTxOverrides())
		const receipt = await tx.wait()
		log.ok(`${label} ${roleName} renounced by ${log.addr(account)}`)
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "revoked",
			txHash: tx.hash,
			blockNumber: receipt?.blockNumber,
		})
	} catch (error) {
		recordOperatorRoleAction(report, {
			operation: "revoke",
			targetLabel: label,
			targetAddress: ethers.getAddress(contractAddress),
			account: ethers.getAddress(account),
			roleName,
			roleHash: role,
			status: "failed",
			error: errorMessage(error),
		})
		throw error
	}
}

async function grantTemporaryOperatorRoles(
	diamondAddress: string,
	peripherals: PeripheralsAddresses,
	config: Config,
	signer: any,
	report?: OperatorRoleReport,
): Promise<void> {
	const operator = resolveUpgradeOperatorAddress(config)
	const migrationRunner = normalizeOptionalAddress(config.migrationRunner) ?? operator
	const signerAddress = ethers.getAddress(await signer.getAddress())
	const controlFacet = new ethers.Contract(diamondAddress, CORE_ACCESS_ABI, signer)

	log.info(`Temporary upgrade operator: ${log.addr(operator)}`)
	if (migrationRunner.toLowerCase() !== operator.toLowerCase()) {
		log.info(`Migration runner: ${log.addr(migrationRunner)}`)
	}

	await grantCoreDefaultAdminIfMissing(controlFacet, diamondAddress, signerAddress, report)
	await grantCoreDefaultAdminIfMissing(controlFacet, diamondAddress, operator, report)
	for (const roleName of CORE_OPERATOR_GRANT_ROLES) {
		if (roleName === "DEFAULT_ADMIN_ROLE") continue
		await grantCoreRoleIfMissing(controlFacet, diamondAddress, operator, roleName, report)
	}
	for (const roleName of CORE_MIGRATION_RUNNER_ROLES) {
		await grantCoreRoleIfMissing(controlFacet, diamondAddress, migrationRunner, roleName, report)
	}

	if (!peripherals.signatureVerifier || !peripherals.accountLayer || !peripherals.instantLayer) {
		throw new Error("operator-grant requires deployed peripherals. Run UPGRADE_STAGES=deploy first.")
	}

	await grantStandardRoleIfMissing(peripherals.signatureVerifier, signer, "MuonSignatureVerifier", operator, "SETTER_ROLE", report)
	await grantAccountLayerRoleIfMissing(peripherals.accountLayer, signer, operator, "DEFAULT_ADMIN_ROLE", report)
	await grantAccountLayerRoleIfMissing(peripherals.accountLayer, signer, operator, "SETTER_ROLE", report)
	await grantStandardRoleIfMissing(peripherals.instantLayer, signer, "InstantLayer", operator, "SETTER_ROLE", report)
}

async function revokeTemporaryOperatorRoles(
	diamondAddress: string,
	peripherals: PeripheralsAddresses,
	config: Config,
	signer: any,
	report?: OperatorRoleReport,
): Promise<void> {
	const operator = resolveUpgradeOperatorAddress(config)
	const protocolAdmin = normalizeOptionalAddress(config.protocolAdmin)
	const signerAddress = ethers.getAddress(await signer.getAddress())
	const signerIsOperator = signerAddress.toLowerCase() === operator.toLowerCase()
	const controlFacet = new ethers.Contract(diamondAddress, CORE_ACCESS_ABI, signer)

	if (protocolAdmin && !signerIsOperator) {
		await grantCoreDefaultAdminIfMissing(controlFacet, diamondAddress, protocolAdmin, report)
	}

	if (!protocolAdmin || operator.toLowerCase() !== protocolAdmin.toLowerCase()) {
		for (const roleName of CORE_OPERATOR_REVOKE_ROLES) {
			await revokeCoreRoleIfPresent(controlFacet, diamondAddress, operator, roleName, report)
		}
	}

	if (peripherals.signatureVerifier && (!protocolAdmin || operator.toLowerCase() !== protocolAdmin.toLowerCase())) {
		if (signerIsOperator) {
			await renounceStandardRoleIfPresent(peripherals.signatureVerifier, signer, "MuonSignatureVerifier", operator, "SETTER_ROLE", report)
		} else {
			await revokeStandardRoleIfPresent(peripherals.signatureVerifier, signer, "MuonSignatureVerifier", operator, "SETTER_ROLE", report)
		}
	}
	if (peripherals.accountLayer && (!protocolAdmin || operator.toLowerCase() !== protocolAdmin.toLowerCase())) {
		await revokeAccountLayerRoleIfPresent(peripherals.accountLayer, signer, operator, "SETTER_ROLE", report)
	}
	if (peripherals.instantLayer && (!protocolAdmin || operator.toLowerCase() !== protocolAdmin.toLowerCase())) {
		if (signerIsOperator) {
			await renounceStandardRoleIfPresent(peripherals.instantLayer, signer, "InstantLayer", operator, "SETTER_ROLE", report)
		} else {
			await revokeStandardRoleIfPresent(peripherals.instantLayer, signer, "InstantLayer", operator, "SETTER_ROLE", report)
		}
	}
}

async function revokeTemporaryOperatorAdminRoles(
	diamondAddress: string,
	peripherals: PeripheralsAddresses,
	config: Config,
	signer: any,
	report?: OperatorRoleReport,
): Promise<void> {
	const operator = resolveUpgradeOperatorAddress(config)
	const protocolAdmin = normalizeOptionalAddress(config.protocolAdmin)
	const controlFacet = new ethers.Contract(diamondAddress, CORE_ACCESS_ABI, signer)

	if (protocolAdmin) {
		await grantCoreDefaultAdminIfMissing(controlFacet, diamondAddress, protocolAdmin, report)
	}

	if (!protocolAdmin || operator.toLowerCase() !== protocolAdmin.toLowerCase()) {
		await revokeCoreRoleIfPresent(controlFacet, diamondAddress, operator, "DEFAULT_ADMIN_ROLE", report)
	}
	if (peripherals.accountLayer && (!protocolAdmin || operator.toLowerCase() !== protocolAdmin.toLowerCase())) {
		await revokeAccountLayerRoleIfPresent(peripherals.accountLayer, signer, operator, "DEFAULT_ADMIN_ROLE", report)
	}
}

async function pauseSystem(diamondAddress: string, signer: any): Promise<void> {
	const signerAddress = await signer.getAddress()
	const controlFacet = new ethers.Contract(diamondAddress, CORE_ACCESS_ABI, signer)
	const defaultAdminRole = ethers.id("DEFAULT_ADMIN_ROLE")
	if (!(await controlFacet.hasRole(signerAddress, defaultAdminRole))) {
		const owner = await readDiamondOwner(controlFacet)
		if (owner && owner.toLowerCase() === ethers.getAddress(signerAddress).toLowerCase()) {
			await grantCoreDefaultAdminIfMissing(controlFacet, diamondAddress, signerAddress)
		}
	}
	await grantCoreRoleIfMissing(controlFacet, diamondAddress, signerAddress, "PAUSER_ROLE")
	await grantCoreRoleIfMissing(controlFacet, diamondAddress, signerAddress, "UNPAUSER_ROLE")

	const pauseHelper = new ethers.Contract(
		diamondAddress,
		["function pauseState() view returns (bool globalPaused, bool, bool, bool, bool, bool, bool)", "function pauseGlobal() external"],
		signer,
	)
	const pauseResult = await pauseHelper.pauseState()
	if (!pauseResult.globalPaused) {
		await (await pauseHelper.pauseGlobal(writeTxOverrides())).wait()
		log.ok("System paused (pauseGlobal)")
	} else {
		log.ok("System already paused")
	}
}

async function unpauseSystem(diamondAddress: string, signer: any): Promise<void> {
	const signerAddress = await signer.getAddress()
	const controlFacet = new ethers.Contract(diamondAddress, CORE_ACCESS_ABI, signer)
	const defaultAdminRole = ethers.id("DEFAULT_ADMIN_ROLE")
	if (!(await controlFacet.hasRole(signerAddress, defaultAdminRole))) {
		const owner = await readDiamondOwner(controlFacet)
		if (owner && owner.toLowerCase() === ethers.getAddress(signerAddress).toLowerCase()) {
			await grantCoreDefaultAdminIfMissing(controlFacet, diamondAddress, signerAddress)
		}
	}
	await grantCoreRoleIfMissing(controlFacet, diamondAddress, signerAddress, "UNPAUSER_ROLE")

	const pauseHelper = new ethers.Contract(
		diamondAddress,
		["function pauseState() view returns (bool globalPaused, bool, bool, bool, bool, bool, bool)", "function unpauseGlobal() external"],
		signer,
	)
	const pauseResult = await pauseHelper.pauseState()
	if (pauseResult.globalPaused) {
		await (await pauseHelper.unpauseGlobal(writeTxOverrides())).wait()
		log.ok("System unpaused (unpauseGlobal)")
	} else {
		log.ok("System already unpaused")
	}
}

async function revokeMigrationRunnerRole(diamondAddress: string, signer: any, migrationRunner: string, roleName: string): Promise<void> {
	const controlFacet = new ethers.Contract(diamondAddress, CORE_ACCESS_ABI, signer)
	await revokeCoreRoleIfPresent(controlFacet, diamondAddress, migrationRunner, roleName)
}

async function enableCrossPartyBMode(diamondAddress: string, signer: any): Promise<void> {
	const diamond = new ethers.Contract(
		diamondAddress,
		["function isCrossPartyBModeActivated() view returns (bool)", "function setCrossPartyBModeActivated(bool activated)"],
		signer,
	)
	if (await diamond.isCrossPartyBModeActivated()) {
		log.ok("Cross-PartyB mode already enabled")
		return
	}
	await (await diamond.setCrossPartyBModeActivated(true, writeTxOverrides())).wait()
	log.ok("Cross-PartyB mode enabled")
}

async function enableCrossPartyBs(diamondAddress: string, signer: any, partyBs: string[]): Promise<void> {
	if (partyBs.length === 0) {
		throw new Error("No PartyBs configured. Set postMigration-{network}.json partyBs or POST_MIGRATION_PARTYBS.")
	}
	const diamond = new ethers.Contract(
		diamondAddress,
		[
			"function isCrossPartyBModeActivated() view returns (bool)",
			"function isCrossPartyB(address partyB) view returns (bool)",
			"function setCrossPartyB(address partyB, bool enabled)",
		],
		signer,
	)
	if (!(await diamond.isCrossPartyBModeActivated())) {
		throw new Error("Cross-PartyB mode is not enabled. Run UPGRADE_STAGES=cross-mode first.")
	}
	for (const partyB of partyBs) {
		if (await diamond.isCrossPartyB(partyB)) {
			log.ok(`Cross-PartyB already enabled for ${log.addr(partyB)}`)
			continue
		}
		await (await diamond.setCrossPartyB(partyB, true, writeTxOverrides())).wait()
		log.ok(`Cross-PartyB enabled for ${log.addr(partyB)}`)
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
		await (await controlFacet.grantRole(signerAddress, ethers.id("PARTY_B_MANAGER_ROLE"), writeTxOverrides())).wait()
		log.ok("PARTY_B_MANAGER_ROLE granted")
		const viewFacet = new ethers.Contract(diamondAddress, ["function isPartyB(address user) view returns (bool)"], signer)
		for (const partyB of partyBsToRegister) {
			const isRegistered: boolean = await viewFacet.isPartyB(partyB)
			if (!isRegistered) {
				await (await controlFacet.registerPartyB(partyB, writeTxOverrides())).wait()
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
				await (await il.registerPartyBs([partyB], writeTxOverrides())).wait()
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
	const networkName = connection.networkName
	const postMigrationConfig = loadPostMigrationConfig(networkName)
	const stages = parseStageList(config)
	const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS ?? config.diamondAddress
	if (!DIAMOND_ADDRESS) throw new Error("DIAMOND_ADDRESS required (env or config)")

	const MIGRATION_RUNNER = process.env.MIGRATION_RUNNER ?? postMigrationConfig.migrationRunner ?? config.migrationRunner ?? config.protocolAdmin
	const newParams = config.newV085Parameters ?? {}
	const DIAMOND_CUT_CHUNK_SIZE = Number(process.env.DIAMOND_CUT_CHUNK_SIZE ?? config.diamondCutChunkSize ?? 6)
	const chainId = Number((await ethers.provider.getNetwork()).chainId)
	const facetsOutFile = process.env.FACETS_FILE ?? path.join(OUTPUT_DIR, `deployed-facets-${networkName}.json`)
	const peripheralsStateFile = process.env.PERIPHERALS_FILE ?? path.join(OUTPUT_DIR, `deployed-peripherals-${networkName}.json`)
	const deploymentStateContext = { networkName, chainId, diamondAddress: DIAMOND_ADDRESS }
	normalizeSignatureVerifierParam(stages, newParams, peripheralsStateFile, deploymentStateContext)

	// Preflight — fail early with a clear message before any on-chain side effects.
	await runPreflight(connection.networkName, {
		diamondAddress: DIAMOND_ADDRESS,
		signatureVerifierAddress: newParams.signatureVerifierAddress,
		newV085Parameters: stages.has("params") ? newParams : undefined,
		stateFiles: [facetsOutFile, peripheralsStateFile],
	})

	log.header("Symmio v0.8.5 EOA Upgrade")
	log.kv("Diamond", log.addr(DIAMOND_ADDRESS))
	log.kv("Stages", stageNames(stages))
	log.kv("Diamond cut chunk size", String(DIAMOND_CUT_CHUNK_SIZE))
	const execute = requireExecutionConfirmation(chainId)
	log.kv("Mode", execute ? "EXECUTE" : "PLAN ONLY")
	log.kv("Facet state", facetsOutFile)
	log.kv("Peripheral state", peripheralsStateFile)
	if (!execute) {
		log.warn(`Plan only: preflight passed and no transactions were sent. Rerun with EXECUTE=true CONFIRM_CHAIN_ID=${chainId}.`)
		return
	}

	const signer = await resolveUpgradeSigner(config, stages)
	const signerAddress = await signer.getAddress()
	const deploymentAdmin = stages.has("peripherals") ? resolveDeploymentAdmin(config, signerAddress) : signerAddress

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
		const symmioFeeReceiver = config.symmioFeeReceiver || deploymentAdmin
		const signatureVerifier = await deploySignatureVerifier(
			deploymentAdmin,
			peripheralsStateFile,
			newParams.signatureVerifierAddress,
			deploymentStateContext,
		)
		if (!newParams.signatureVerifierAddress || !ethers.isAddress(newParams.signatureVerifierAddress)) {
			newParams.signatureVerifierAddress = signatureVerifier
		}
		writeSignatureVerifierToUpgradeConfig(signatureVerifier)
		const accountLayerCutSigner = signerAddress.toLowerCase() === deploymentAdmin.toLowerCase() ? signer : undefined
		const alResult = await deployAccountLayerDiamond(
			deploymentAdmin,
			symmioFeeReceiver,
			peripheralsStateFile,
			accountLayerCutSigner,
			deploymentStateContext,
		)
		await initiateAccountLayerOwnershipTransfer(alResult.diamondAddress, signer, deploymentAdmin)
		const ilResult = await deployInstantLayer(DIAMOND_ADDRESS, deploymentAdmin, peripheralsStateFile, deploymentStateContext)
		await deploySymmioPartyBImplementation(peripheralsStateFile, deploymentStateContext)
		const smResult = await deploySymbolManager(DIAMOND_ADDRESS, deploymentAdmin, peripheralsStateFile, deploymentStateContext)
		peripherals = {
			signatureVerifier,
			accountLayer: alResult.diamondAddress,
			instantLayer: ilResult.address,
			symbolManager: smResult.address,
		}
		log.stepDone(t)
	}

	if (stages.has("operator-grant")) {
		const t = log.step("Grant temporary operator roles")
		peripherals = { ...peripherals, ...readPeripheralsAddresses(peripheralsStateFile, deploymentStateContext) }
		const report = createOperatorRoleReport("operator-grant", networkName, chainId, DIAMOND_ADDRESS, signerAddress, config, MIGRATION_RUNNER)
		writeOperatorRoleReport(report)
		log.info(`Role report: ${report.outputFile}`)
		try {
			await grantTemporaryOperatorRoles(DIAMOND_ADDRESS, peripherals, config, signer, report)
			finishOperatorRoleReport(report, "success")
		} catch (error) {
			finishOperatorRoleReport(report, "failed", error)
			throw error
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
			...(await requirePeripheralAddresses(peripheralsStateFile, ["accountLayer", "instantLayer", "symbolManager"], deploymentStateContext)),
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
			await (await controlFacet.grantRole(MIGRATION_RUNNER, ethers.id("MIGRATION_ROLE"), writeTxOverrides())).wait()
			log.ok(`MIGRATION_ROLE granted to ${log.addr(MIGRATION_RUNNER)}`)
		} else {
			log.warn("No migration runner configured — skipping")
		}
		log.stepDone(t)
	}

	if (stages.has("cross-mode")) {
		const t = log.step("Enable global cross-PartyB mode")
		await enableCrossPartyBMode(DIAMOND_ADDRESS, signer)
		log.stepDone(t)
	}

	if (stages.has("cross-partyb")) {
		const t = log.step("Enable cross mode for PartyBs")
		const partyBs = resolvePostMigrationPartyBs(postMigrationConfig)
		await enableCrossPartyBs(DIAMOND_ADDRESS, signer, partyBs)
		log.stepDone(t)
	}

	if (stages.has("migration-revoke")) {
		const t = log.step("Revoke migration role")
		const migrationRunner = resolveMigrationRunnerAddress(config, postMigrationConfig)
		await revokeMigrationRunnerRole(DIAMOND_ADDRESS, signer, migrationRunner, "MIGRATION_ROLE")
		log.stepDone(t)
	}

	if (stages.has("symbol-revoke")) {
		const t = log.step("Revoke symbol manager role")
		const migrationRunner = resolveMigrationRunnerAddress(config, postMigrationConfig)
		await revokeMigrationRunnerRole(DIAMOND_ADDRESS, signer, migrationRunner, "SYMBOL_MANAGER_ROLE")
		log.stepDone(t)
	}

	if (stages.has("unpause")) {
		const t = log.step("Unpause system")
		await unpauseSystem(DIAMOND_ADDRESS, signer)
		log.stepDone(t)
	}

	if (stages.has("operator-revoke")) {
		const t = log.step("Revoke temporary non-admin operator roles")
		peripherals = { ...peripherals, ...readPeripheralsAddresses(peripheralsStateFile, deploymentStateContext) }
		const report = createOperatorRoleReport("operator-revoke", networkName, chainId, DIAMOND_ADDRESS, signerAddress, config, MIGRATION_RUNNER)
		writeOperatorRoleReport(report)
		log.info(`Role report: ${report.outputFile}`)
		try {
			await revokeTemporaryOperatorRoles(DIAMOND_ADDRESS, peripherals, config, signer, report)
			finishOperatorRoleReport(report, "success")
		} catch (error) {
			finishOperatorRoleReport(report, "failed", error)
			throw error
		}
		log.stepDone(t)
	}

	if (stages.has("operator-admin-revoke")) {
		const t = log.step("Revoke temporary operator admin roles")
		peripherals = { ...peripherals, ...readPeripheralsAddresses(peripheralsStateFile, deploymentStateContext) }
		const report = createOperatorRoleReport("operator-admin-revoke", networkName, chainId, DIAMOND_ADDRESS, signerAddress, config, MIGRATION_RUNNER)
		writeOperatorRoleReport(report)
		log.info(`Role report: ${report.outputFile}`)
		try {
			await revokeTemporaryOperatorAdminRoles(DIAMOND_ADDRESS, peripherals, config, signer, report)
			finishOperatorRoleReport(report, "success")
		} catch (error) {
			finishOperatorRoleReport(report, "failed", error)
			throw error
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
			{ label: "upgradeOperator", address: config.upgradeOperator },
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
