/**
 * Deploy and wire AccountLayer Diamond + InstantLayer for the v0.8.5 upgrade.
 *
 * These contracts are new in v0.8.5 and must be deployed fresh during the upgrade.
 */
import type { Interface, Provider } from "ethers"
import fs from "fs"
import path from "path"

import { deploymentOnlyArtifact } from "../../../tasks/deploy/artifacts.js"
import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers, hre } from "../../../test/helpers/hardhat-connection.js"
import { loadDeploymentState, saveDeploymentState, resolveDeploymentStateMetadata, type DeploymentStateContext } from "./deploymentState.js"
import { log } from "./log.js"
import { accountLayerCutTxOverrides, deployTxOverrides, writeTxOverrides } from "./txOverrides.js"

// ============================================================================
// Constants
// ============================================================================

const AccountLayerFacetNames = ["CoreFacet", "MarginFacet", "SymmioHookFacet", "ControlFacet", "ViewFacet", "AffiliateFacet", "DiamondLoupeFacet"]

const AccountLayerFacetLibraryDependencies: Record<string, string[]> = {
	CoreFacet: ["LibQuoteParams"],
}

const AccountLayerFacetPathMap: Record<string, string> = {
	CoreFacet: "contracts/accountLayer/facets/Core/CoreFacet.sol:CoreFacet",
	MarginFacet: "contracts/accountLayer/facets/Margin/MarginFacet.sol:MarginFacet",
	SymmioHookFacet: "contracts/accountLayer/facets/SymmioHook/SymmioHookFacet.sol:SymmioHookFacet",
	ControlFacet: "contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
	ViewFacet: "contracts/accountLayer/facets/View/ViewFacet.sol:ViewFacet",
	AffiliateFacet: "contracts/accountLayer/facets/Affiliate/AffiliateFacet.sol:AffiliateFacet",
	DiamondLoupeFacet: "DiamondLoupeFacet",
}

// ============================================================================
// Types
// ============================================================================

export type AccountLayerDeployResult = {
	diamondAddress: string
	diamondCutFacetAddress: string
	initAddress: string
	libraryAddresses: Record<string, string>
	facetAddresses: Record<string, string>
}

export type InstantLayerDeployResult = {
	address: string
}

export type AccountLayerInstantLayerReport = {
	accountLayerDiamond: AccountLayerDeployResult
	instantLayer: InstantLayerDeployResult
}

type DeployedState = {
	metadata?: {
		networkName?: string
		chainId?: number
		diamondAddress?: string
	}
	accountLayer?: {
		diamondCutFacet?: string
		diamond?: string
		init?: string
		libraries?: Record<string, string>
		facets?: Record<string, string>
		diamondCutComplete?: boolean
	}
	instantLayer?: {
		address?: string
	}
	symbolManager?: {
		address?: string
	}
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir: string): void {
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function saveState(filePath: string, state: DeployedState, metadata?: DeploymentStateContext): void {
	if (!filePath) return
	ensureDir(path.dirname(filePath))
	saveDeploymentState(filePath, state, metadata)
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
	const value = process.env[name]
	if (value === undefined || value.trim() === "") return fallback
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function requireDeployedCode(label: string, address: string): Promise<void> {
	if (!ethers.isAddress(address) || address === ethers.ZeroAddress) throw new Error(`${label} has an invalid cached address: ${address}`)
	if ((await ethers.provider.getCode(address)) === "0x") {
		throw new Error(`${label} has no code at cached/deployed address ${address}; reconcile the deployment transaction before resuming`)
	}
}

async function withPartyBPrefilterRetry<T>(label: string, read: () => Promise<T>): Promise<T> {
	const maxRetries = parseNonNegativeIntEnv("PARTYB_PREFILTER_MAX_RETRIES", 4)
	const baseDelayMs = parseNonNegativeIntEnv("PARTYB_PREFILTER_RETRY_DELAY_MS", 1_000)
	let attempt = 0
	let delay = baseDelayMs

	while (true) {
		try {
			return await read()
		} catch (error) {
			attempt += 1
			if (attempt > maxRetries) {
				throw new Error(`${label} failed after ${maxRetries} retries: ${errorMessage(error)}`)
			}
			log.warn(`${label} failed (${errorMessage(error)}); retry ${attempt}/${maxRetries} in ${delay}ms`)
			await sleep(delay)
			delay = Math.min(delay * 2, 10_000)
		}
	}
}

// ============================================================================
// Deploy AccountLayer Diamond
// ============================================================================

export async function deployAccountLayerDiamond(
	protocolAdmin: string,
	symmioFeeReceiver: string,
	stateFile?: string,
	adminSigner?: any,
	stateContext?: DeploymentStateContext,
): Promise<AccountLayerDeployResult> {
	const metadata = stateFile ? await resolveDeploymentStateMetadata(stateContext) : undefined
	const state = loadDeploymentState<DeployedState>(stateFile ?? "", metadata)
	if (!state.accountLayer) state.accountLayer = {}
	const al = state.accountLayer

	log.info("AccountLayer Diamond:")

	// 1. DiamondCutFacet
	let diamondCutFacetAddress: string
	if (al.diamondCutFacet) {
		diamondCutFacetAddress = al.diamondCutFacet
		await requireDeployedCode("AccountLayer DiamondCutFacet", diamondCutFacetAddress)
		log.deployed("DiamondCutFacet", diamondCutFacetAddress, true)
	} else {
		const factory = await ethers.getContractFactory("DiamondCutFacet")
		const contract = await factory.deploy(deployTxOverrides())
		diamondCutFacetAddress = await contract.getAddress()
		await contract.waitForDeployment()
		await requireDeployedCode("AccountLayer DiamondCutFacet", diamondCutFacetAddress)
		al.diamondCutFacet = diamondCutFacetAddress
		if (stateFile) saveState(stateFile, state, metadata)
		log.deployed("DiamondCutFacet", diamondCutFacetAddress)
	}

	// 2. Diamond proxy — deployed with deployer as owner so this script can
	//    call diamondCut directly. The Init grants DEFAULT_ADMIN_ROLE to
	//    protocolAdmin for role-based governance.
	const [deployer] = await ethers.getSigners()

	let diamondAddress: string
	if (al.diamond) {
		diamondAddress = al.diamond
		await requireDeployedCode("AccountLayer Diamond", diamondAddress)
		log.deployed("Diamond", diamondAddress, true)
	} else {
		const factory = await ethers.getContractFactory("Diamond")
		const deployOwner = adminSigner ? protocolAdmin : await deployer.getAddress()
		const contract = await factory.deploy(deployOwner, diamondCutFacetAddress, deployTxOverrides())
		diamondAddress = await contract.getAddress()
		await contract.waitForDeployment()
		await requireDeployedCode("AccountLayer Diamond", diamondAddress)
		al.diamond = diamondAddress
		if (stateFile) saveState(stateFile, state, metadata)
		log.deployed("Diamond", diamondAddress)
	}

	// 3. Init contract
	let initAddress: string
	if (al.init) {
		initAddress = al.init
		await requireDeployedCode("AccountLayer Init", initAddress)
		log.deployed("Init", initAddress, true)
	} else {
		const factory = await ethers.getContractFactory("contracts/accountLayer/Init.sol:Init")
		const contract = await factory.deploy(deployTxOverrides())
		initAddress = await contract.getAddress()
		await contract.waitForDeployment()
		await requireDeployedCode("AccountLayer Init", initAddress)
		al.init = initAddress
		if (stateFile) saveState(stateFile, state, metadata)
		log.deployed("Init", initAddress)
	}

	// 4. LibQuoteParams library
	if (!al.libraries) al.libraries = {}
	const libraryAddresses: Record<string, string> = { ...al.libraries }

	if (libraryAddresses["LibQuoteParams"]) {
		await requireDeployedCode("AccountLayer LibQuoteParams", libraryAddresses["LibQuoteParams"])
		log.deployed("LibQuoteParams", libraryAddresses["LibQuoteParams"], true)
	} else {
		const artifact = await hre.artifacts.readArtifact("contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams")
		const factory = await ethers.getContractFactoryFromArtifact(deploymentOnlyArtifact(artifact))
		const contract = await factory.deploy(deployTxOverrides())
		const libraryAddress = await contract.getAddress()
		await contract.waitForDeployment()
		await requireDeployedCode("AccountLayer LibQuoteParams", libraryAddress)
		libraryAddresses["LibQuoteParams"] = libraryAddress
		al.libraries["LibQuoteParams"] = libraryAddress
		if (stateFile) saveState(stateFile, state, metadata)
		log.deployed("LibQuoteParams", libraryAddress)
	}

	// 5. Deploy 7 facets
	if (!al.facets) al.facets = {}
	const facetAddresses: Record<string, string> = { ...al.facets }

	const cut: Array<{ facetAddress: string; action: number; functionSelectors: string[] }> = []

	for (let i = 0; i < AccountLayerFacetNames.length; i++) {
		const facetName = AccountLayerFacetNames[i]
		const contractPath = AccountLayerFacetPathMap[facetName]

		let facetAddress: string
		if (facetAddresses[facetName]) {
			facetAddress = facetAddresses[facetName]
			await requireDeployedCode(`AccountLayer ${facetName}`, facetAddress)
			log.skipped(facetName, facetAddress)
		} else {
			const requiredLibraries = AccountLayerFacetLibraryDependencies[facetName]
			let factory
			if (requiredLibraries && requiredLibraries.length > 0) {
				const libraries: Record<string, string> = {}
				for (const lib of requiredLibraries) {
					libraries[`project/contracts/accountLayer/libraries/${lib}.sol:${lib}`] = libraryAddresses[lib]
				}
				factory = await ethers.getContractFactory(contractPath, { libraries })
			} else {
				factory = await ethers.getContractFactory(contractPath)
			}
			const facet = await factory.deploy(deployTxOverrides())
			facetAddress = await facet.getAddress()
			await facet.waitForDeployment()
			await requireDeployedCode(`AccountLayer ${facetName}`, facetAddress)
			facetAddresses[facetName] = facetAddress
			al.facets[facetName] = facetAddress
			if (stateFile) saveState(stateFile, state, metadata)
			log.progress(i + 1, AccountLayerFacetNames.length, `${log.name(facetName)}  ${log.addr(facetAddress)}`)
		}

		// Get selectors for diamond cut
		const facet = await ethers.getContractAt(contractPath, facetAddress)
		cut.push({
			facetAddress,
			action: FacetCutAction.Add,
			functionSelectors: getSelectors(ethers, facet as any).selectors,
		})
	}

	// 6. Reconcile and apply the diamond cut with Init. Install the loupe first
	// so every later resume can derive missing selectors from live state, even
	// when a prior run stopped between cut chunks.
	const diamondCutContract = await ethers.getContractAt("IDiamondCut", diamondAddress, adminSigner)
	const loupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress)
	try {
		await loupe.facets()
	} catch {
		if (al.diamondCutComplete) {
			throw new Error("Cached diamondCutComplete=true, but the AccountLayer loupe is not callable")
		}
		const loupeCut = cut.find(entry => entry.facetAddress === facetAddresses["DiamondLoupeFacet"])
		if (!loupeCut) throw new Error("DiamondLoupeFacet cut entry is missing")
		const receipt = await (await diamondCutContract.diamondCut([loupeCut], ethers.ZeroAddress, "0x", accountLayerCutTxOverrides())).wait()
		if (!receipt?.status) throw new Error("AccountLayer loupe bootstrap cut failed")
		log.ok("DiamondLoupeFacet bootstrap cut applied and confirmed")
	}

	const selectorOwners = new Map<string, string>()
	for (const liveFacet of await loupe.facets()) {
		for (const selector of liveFacet.functionSelectors) selectorOwners.set(selector.toLowerCase(), ethers.getAddress(liveFacet.facetAddress))
	}
	let installedExpectedSelectors = 0
	const remainingCut = cut.flatMap(entry => {
		const expectedFacet = ethers.getAddress(entry.facetAddress)
		const missing = entry.functionSelectors.filter(selector => {
			const currentFacet = selectorOwners.get(selector.toLowerCase())
			if (!currentFacet) return true
			if (currentFacet !== expectedFacet) {
				throw new Error(
					`AccountLayer selector ${selector} maps to ${currentFacet}, expected ${expectedFacet}; refusing to overwrite unexpected state`,
				)
			}
			installedExpectedSelectors++
			return false
		})
		return missing.length > 0 ? [{ ...entry, functionSelectors: missing }] : []
	})

	// AccountStorage.Layout.initAccountManagerCodeHash is at slot +10. Unlike a
	// facet getter, this remains readable during a partial cut where ViewFacet is
	// not installed yet. A non-zero hash proves Init has already executed and
	// prevents accidentally running its non-idempotent delegatecall twice.
	const accountStorageSlot = BigInt(ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.storage.accountlayer.account")))
	const initCodeHashSlot = ethers.toBeHex(accountStorageSlot + 10n, 32)
	let initialized = BigInt(await ethers.provider.getStorage(diamondAddress, initCodeHashSlot)) !== 0n
	const init = await ethers.getContractAt("contracts/accountLayer/Init.sol:Init", initAddress)
	const accountManagerFactory = await ethers.getContractFactory("contracts/accountLayer/AccountManager.sol:AccountManager")
	const initCalldata = init.interface.encodeFunctionData("init", [protocolAdmin, symmioFeeReceiver, accountManagerFactory.bytecode])

	if (al.diamondCutComplete && remainingCut.length > 0) {
		throw new Error(
			`Cached diamondCutComplete=true, but ${remainingCut.reduce((sum, entry) => sum + entry.functionSelectors.length, 0)} selectors are missing`,
		)
	}

	if (remainingCut.length > 0) {
		const chunkSize = 3
		const totalChunks = Math.ceil(remainingCut.length / chunkSize)
		for (let index = 0; index < remainingCut.length; index += chunkSize) {
			const chunk = remainingCut.slice(index, index + chunkSize)
			const chunkNum = Math.floor(index / chunkSize) + 1
			const shouldInitialize = !initialized && index === 0
			const tx = await diamondCutContract.diamondCut(
				chunk,
				shouldInitialize ? initAddress : ethers.ZeroAddress,
				shouldInitialize ? initCalldata : "0x",
				accountLayerCutTxOverrides(),
			)
			const receipt = await tx.wait()
			if (!receipt?.status) throw new Error(`AccountLayer diamond cut failed in chunk ${chunkNum}/${totalChunks}`)
			log.ok(`Diamond cut chunk ${chunkNum}/${totalChunks} applied and confirmed`)
			if (shouldInitialize) initialized = true
		}
	} else if (!initialized) {
		const receipt = await (await diamondCutContract.diamondCut([], initAddress, initCalldata, accountLayerCutTxOverrides())).wait()
		if (!receipt?.status) throw new Error("AccountLayer Init-only diamond cut failed")
		initialized = true
		log.ok("AccountLayer Init-only diamond cut applied and confirmed")
	} else {
		log.ok(`Diamond cut already complete (${installedExpectedSelectors} selectors verified on-chain)`)
	}

	for (const entry of cut) {
		for (const selector of entry.functionSelectors) {
			const installedAt = ethers.getAddress(await loupe.facetAddress(selector))
			if (installedAt !== ethers.getAddress(entry.facetAddress)) {
				throw new Error(`AccountLayer post-cut mismatch: selector ${selector} maps to ${installedAt}, expected ${entry.facetAddress}`)
			}
		}
	}

	if (!initialized) throw new Error("AccountLayer Init did not execute")
	const viewFacet = await ethers.getContractAt(AccountLayerFacetPathMap["ViewFacet"], diamondAddress)
	for (const roleName of ["DEFAULT_ADMIN_ROLE", "SETTER_ROLE", "PAUSER_ROLE", "UNPAUSER_ROLE", "APPROVER_ROLE"]) {
		if (!(await viewFacet.hasRole(protocolAdmin, ethers.id(roleName)))) {
			throw new Error(`AccountLayer Init post-state mismatch: ${protocolAdmin} lacks ${roleName}`)
		}
	}
	const configuredFeeReceiver = ethers.getAddress(await viewFacet.symmioFeeReceiver())
	if (configuredFeeReceiver !== ethers.getAddress(symmioFeeReceiver)) {
		throw new Error(`AccountLayer Init post-state mismatch: fee receiver is ${configuredFeeReceiver}, expected ${symmioFeeReceiver}`)
	}
	const configuredAccountManagerBytecode: string = await viewFacet.accountManagerImplementation()
	if (ethers.keccak256(configuredAccountManagerBytecode) !== ethers.keccak256(accountManagerFactory.bytecode)) {
		throw new Error("AccountLayer Init post-state mismatch: AccountManager implementation bytecode differs")
	}

	al.diamondCutComplete = true
	if (stateFile) saveState(stateFile, state, metadata)

	log.ok(`AccountLayer Diamond: ${log.addr(diamondAddress)}`)

	return {
		diamondAddress,
		diamondCutFacetAddress,
		initAddress,
		libraryAddresses,
		facetAddresses,
	}
}

// ============================================================================
// Deploy InstantLayer
// ============================================================================

export async function deployInstantLayer(
	symmioAddress: string,
	protocolAdmin: string,
	stateFile?: string,
	stateContext?: DeploymentStateContext,
): Promise<InstantLayerDeployResult> {
	const metadata = stateFile ? await resolveDeploymentStateMetadata({ diamondAddress: symmioAddress, ...stateContext }) : undefined
	const state = loadDeploymentState<DeployedState>(stateFile ?? "", metadata)

	if (state.instantLayer?.address) {
		await requireDeployedCode("InstantLayer", state.instantLayer.address)
		log.deployed("InstantLayer", state.instantLayer.address, true)
		return { address: state.instantLayer.address }
	}

	const factory = await ethers.getContractFactory("InstantLayer")
	const contract = await factory.deploy(symmioAddress, protocolAdmin, deployTxOverrides())
	const address = await contract.getAddress()
	await contract.waitForDeployment()
	await requireDeployedCode("InstantLayer", address)

	if (!state.instantLayer) state.instantLayer = {}
	state.instantLayer.address = address
	if (stateFile) saveState(stateFile, state, metadata)

	log.deployed("InstantLayer", address)
	return { address }
}

// ============================================================================
// Wire AccountLayer + InstantLayer to Diamond
// ============================================================================

export async function wireAccountLayerInstantLayer(
	diamondAddress: string,
	accountLayerDiamondAddress: string,
	instantLayerAddress: string,
	adminSigner: any,
): Promise<void> {
	log.info("Wiring:")

	const roleHash = (name: string) => ethers.id(name)
	const adminAddress = await adminSigner.getAddress()

	// Core Diamond ControlFacet
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress, adminSigner)

	// Grant INTEGRATION_ADMIN_ROLE to admin (needed for registerHook)
	await (await controlFacet.grantRole(adminAddress, roleHash("INTEGRATION_ADMIN_ROLE"), writeTxOverrides())).wait()

	// Grant roles to AccountLayer on Diamond
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("SIGNER_ADMIN_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(AccountLayer, SIGNER_ADMIN_ROLE)")
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("AFFILIATE_MANAGER_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(AccountLayer, AFFILIATE_MANAGER_ROLE)")
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("BALANCE_SETTLER_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(AccountLayer, BALANCE_SETTLER_ROLE)")

	// Grant InstantLayer role on Diamond
	await (await controlFacet.grantRole(instantLayerAddress, roleHash("INSTANT_LAYER_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(InstantLayer, INSTANT_LAYER_ROLE)")

	// Register AccountLayer as system hook on Diamond
	await (await controlFacet.registerHook(ethers.ZeroAddress, accountLayerDiamondAddress, writeTxOverrides())).wait()
	log.ok("registerHook(address(0), AccountLayer)")

	// AccountLayer Diamond ControlFacet
	const alControlFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		accountLayerDiamondAddress,
		adminSigner,
	)

	// Grant InstantLayer SIGNER_SETTER_ROLE on AccountLayer
	await (await alControlFacet.grantRole(instantLayerAddress, roleHash("SIGNER_SETTER_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(InstantLayer, SIGNER_SETTER_ROLE) on AccountLayer")

	// Whitelist Symmio Core on AccountLayer
	await (await alControlFacet.setWhitelistedSymmioCore(diamondAddress, true, writeTxOverrides())).wait()
	log.ok("setWhitelistedSymmioCore(Diamond, true)")

	// InstantLayer configuration
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)

	// Set AccountLayer on InstantLayer
	await (await instantLayer.setAccountLayer(accountLayerDiamondAddress, writeTxOverrides())).wait()
	log.ok("setAccountLayer(AccountLayer)")

	// Whitelist Diamond and AccountLayer on InstantLayer
	await (await instantLayer.setTargetWhitelist(diamondAddress, true, writeTxOverrides())).wait()
	log.ok("setTargetWhitelist(Diamond, true)")
	await (await instantLayer.setTargetWhitelist(accountLayerDiamondAddress, true, writeTxOverrides())).wait()
	log.ok("setTargetWhitelist(AccountLayer, true)")
}

// ============================================================================
// Setup InstantLayer Templates
// ============================================================================

const DEFAULT_TEMPLATES_FILE = "./scripts/upgrade/config/instantLayerTemplates.json"

type TemplateConfig = {
	name: string
	operations: { insertionPoints: number[]; sourceIndices: number[]; sourceOffsets: number[] }[]
}

function loadTemplates(configFile?: string): TemplateConfig[] {
	const file = configFile ?? process.env.TEMPLATES_CONFIG_FILE ?? DEFAULT_TEMPLATES_FILE
	if (!fs.existsSync(file)) {
		throw new Error(`InstantLayer templates config not found: ${file}`)
	}
	let config: { templates?: TemplateConfig[] }
	try {
		config = JSON.parse(fs.readFileSync(file, "utf-8")) as { templates?: TemplateConfig[] }
	} catch (error) {
		throw new Error(`Invalid InstantLayer templates config ${file}: ${errorMessage(error)}`)
	}
	if (!Array.isArray(config.templates) || config.templates.length === 0) {
		throw new Error(`No templates defined in ${file}`)
	}
	const names = new Set<string>()
	for (const [templateIndex, template] of config.templates.entries()) {
		if (!template || typeof template.name !== "string" || template.name.trim() === "" || template.name !== template.name.trim()) {
			throw new Error(`Template ${templateIndex} in ${file} must have a non-empty trimmed name`)
		}
		if (names.has(template.name)) throw new Error(`Duplicate template name "${template.name}" in ${file}`)
		names.add(template.name)
		if (!Array.isArray(template.operations) || template.operations.length === 0) {
			throw new Error(`Template "${template.name}" in ${file} must contain at least one operation`)
		}
		for (const [operationIndex, operation] of template.operations.entries()) {
			for (const field of ["insertionPoints", "sourceIndices", "sourceOffsets"] as const) {
				if (!Array.isArray(operation?.[field])) throw new Error(`Template "${template.name}" operation ${operationIndex}.${field} must be an array`)
				for (const value of operation[field]) {
					if (!Number.isSafeInteger(value) || value < 0) {
						throw new Error(`Template "${template.name}" operation ${operationIndex}.${field} contains invalid value ${value}`)
					}
				}
			}
			if (
				operation.insertionPoints.length !== operation.sourceIndices.length ||
				operation.insertionPoints.length !== operation.sourceOffsets.length
			) {
				throw new Error(`Template "${template.name}" operation ${operationIndex} has mismatched injection-array lengths`)
			}
			for (const sourceIndex of operation.sourceIndices) {
				if (sourceIndex >= operationIndex) {
					throw new Error(`Template "${template.name}" operation ${operationIndex} references non-preceding source operation ${sourceIndex}`)
				}
			}
		}
	}
	return config.templates
}

function compareUintArray(actual: readonly bigint[], expected: readonly number[], field: string): void {
	if (actual.length !== expected.length) throw new Error(`${field} length is ${actual.length}; expected ${expected.length}`)
	for (let index = 0; index < expected.length; index++) {
		if (actual[index] !== BigInt(expected[index])) throw new Error(`${field}[${index}] is ${actual[index]}; expected ${expected[index]}`)
	}
}

function assertTemplateMatches(templateId: number, actual: any, expected: TemplateConfig): void {
	const prefix = `InstantLayer template ${templateId}`
	if (actual.name !== expected.name) throw new Error(`${prefix} is named "${actual.name}"; expected "${expected.name}"`)
	if (actual.active !== true) throw new Error(`${prefix} (${expected.name}) is inactive; expected active`)
	if (actual.operations.length !== expected.operations.length) {
		throw new Error(`${prefix} (${expected.name}) has ${actual.operations.length} operations; expected ${expected.operations.length}`)
	}
	for (const [operationIndex, expectedOperation] of expected.operations.entries()) {
		const actualOperation = actual.operations[operationIndex]
		compareUintArray(actualOperation.insertionPoints, expectedOperation.insertionPoints, `${prefix}.operations[${operationIndex}].insertionPoints`)
		compareUintArray(actualOperation.sourceIndices, expectedOperation.sourceIndices, `${prefix}.operations[${operationIndex}].sourceIndices`)
		compareUintArray(actualOperation.sourceOffsets, expectedOperation.sourceOffsets, `${prefix}.operations[${operationIndex}].sourceOffsets`)
	}
}

export async function setupInstantLayerTemplates(instantLayerAddress: string, adminSigner: any, configFile?: string): Promise<void> {
	log.info("Templates:")

	const templates = loadTemplates(configFile)
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)
	const existingCountRaw = await instantLayer.nextTemplateId()
	if (existingCountRaw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`InstantLayer nextTemplateId is too large: ${existingCountRaw}`)
	const existingCount = Number(existingCountRaw)
	if (existingCount > templates.length) {
		throw new Error(
			`InstantLayer already has ${existingCount} templates, but config defines only ${templates.length}; refusing to append or reorder IDs`,
		)
	}

	for (let templateId = 0; templateId < existingCount; templateId++) {
		const existing = await instantLayer.getTemplate(templateId)
		assertTemplateMatches(templateId, existing, templates[templateId])
		log.info(`Template ${templateId} ${templates[templateId].name} already matches on-chain (${templates[templateId].operations.length} ops)`)
	}

	for (let templateId = existingCount; templateId < templates.length; templateId++) {
		const template = templates[templateId]
		const tx = await instantLayer.addTemplate(template.name, template.operations, writeTxOverrides())
		const receipt = await tx.wait()
		if (!receipt?.status) throw new Error(`addTemplate(${template.name}) failed for expected template id ${templateId}`)
		const added = await instantLayer.getTemplate(templateId)
		assertTemplateMatches(templateId, added, template)
		log.ok(`${template.name} (${template.operations.length} ops) added and verified at id ${templateId}`)
	}

	const finalCount = await instantLayer.nextTemplateId()
	if (finalCount !== BigInt(templates.length)) throw new Error(`InstantLayer has ${finalCount} templates after setup; expected ${templates.length}`)
	log.ok(`Exact template order and operation data verified for ${templates.length} template(s)`)
}

// ============================================================================
// Build wiring transactions for Safe path
// ============================================================================

export type WiringTransaction = {
	to: string
	value: string
	calldata: string
	description: string
	iface: Interface
	methodName: string
	args: any[]
}

/**
 * Filter a PartyB list against current on-chain registration state.
 *
 * Returns the subset that still needs to be registered on Diamond (via
 * ViewFacet.isPartyB) and on InstantLayer (via registeredPartyBs). Also
 * returns the per-address state for logging.
 *
 * InstantLayer's registerPartyBs reverts with EmptyArray() if called with an
 * empty list, so callers should skip the IL tx if the filtered list is empty.
 */
export async function filterUnregisteredPartyBs(
	provider: Provider,
	diamondAddress: string,
	instantLayerAddress: string | undefined,
	partyBs: string[],
	opts: { registerOnSymmioCore: boolean; registerOnInstantLayer: boolean },
): Promise<{
	partyBsForDiamond: string[]
	partyBsForInstantLayer: string[]
	states: { address: string; onDiamond: boolean | null; onInstantLayer: boolean | null }[]
}> {
	const viewFacetIface = new ethers.Interface(["function isPartyB(address user) view returns (bool)"])
	const instantLayerIface = new ethers.Interface(["function registeredPartyBs(address) view returns (bool)"])

	const diamond = opts.registerOnSymmioCore ? new ethers.Contract(diamondAddress, viewFacetIface, provider) : null
	const il = opts.registerOnInstantLayer && instantLayerAddress ? new ethers.Contract(instantLayerAddress, instantLayerIface, provider) : null

	const states: { address: string; onDiamond: boolean | null; onInstantLayer: boolean | null }[] = []
	const partyBsForDiamond: string[] = []
	const partyBsForInstantLayer: string[] = []

	for (const raw of partyBs) {
		const addr = ethers.getAddress(raw)
		const onDiamond: boolean | null = diamond ? await withPartyBPrefilterRetry(`isPartyB(${addr})`, () => diamond.isPartyB(addr)) : null
		const onInstantLayer: boolean | null = il ? await withPartyBPrefilterRetry(`registeredPartyBs(${addr})`, () => il.registeredPartyBs(addr)) : null
		states.push({ address: addr, onDiamond, onInstantLayer })
		if (diamond && onDiamond === false) partyBsForDiamond.push(addr)
		if (il && onInstantLayer === false) partyBsForInstantLayer.push(addr)
	}

	return { partyBsForDiamond, partyBsForInstantLayer, states }
}

export function buildWiringTransactions(
	diamondAddress: string,
	accountLayerDiamondAddress: string,
	instantLayerAddress: string,
	protocolAdmin: string,
	partyBsForDiamond: string[] = [],
	partyBsForInstantLayer: string[] = [],
): WiringTransaction[] {
	const roleHash = (name: string) => ethers.id(name)
	const txs: WiringTransaction[] = []

	// ABIs for encoding
	const controlFacetIface = new ethers.Interface([
		"function grantRole(address account, bytes32 role)",
		"function registerHook(address affiliate, address hook)",
		"function registerPartyB(address partyB)",
	])

	const alControlFacetIface = new ethers.Interface([
		"function grantRole(address account, bytes32 role)",
		"function setWhitelistedSymmioCore(address symmioCore, bool whitelisted)",
	])

	const instantLayerIface = new ethers.Interface([
		"function setAccountLayer(address accountLayer)",
		"function setTargetWhitelist(address target, bool whitelisted)",
		"function registerPartyBs(address[] partyBs)",
	])

	const proxyAdminIface = new ethers.Interface(["function upgrade(address proxy, address implementation)"])

	// Helper to reduce repetition
	const push = (to: string, iface: Interface, methodName: string, args: any[], description: string) => {
		txs.push({
			to,
			value: "0",
			calldata: iface.encodeFunctionData(methodName, args),
			description,
			iface,
			methodName,
			args,
		})
	}

	// On core Diamond
	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[protocolAdmin, roleHash("INTEGRATION_ADMIN_ROLE")],
		`grantRole(protocolAdmin, INTEGRATION_ADMIN_ROLE)`,
	)
	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[accountLayerDiamondAddress, roleHash("SIGNER_ADMIN_ROLE")],
		`grantRole(AccountLayer, SIGNER_ADMIN_ROLE)`,
	)
	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[accountLayerDiamondAddress, roleHash("AFFILIATE_MANAGER_ROLE")],
		`grantRole(AccountLayer, AFFILIATE_MANAGER_ROLE)`,
	)
	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[accountLayerDiamondAddress, roleHash("BALANCE_SETTLER_ROLE")],
		`grantRole(AccountLayer, BALANCE_SETTLER_ROLE)`,
	)
	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[instantLayerAddress, roleHash("INSTANT_LAYER_ROLE")],
		`grantRole(InstantLayer, INSTANT_LAYER_ROLE)`,
	)
	push(diamondAddress, controlFacetIface, "registerHook", [ethers.ZeroAddress, accountLayerDiamondAddress], `registerHook(address(0), AccountLayer)`)

	// On AccountLayer Diamond
	push(
		accountLayerDiamondAddress,
		alControlFacetIface,
		"grantRole",
		[instantLayerAddress, roleHash("SIGNER_SETTER_ROLE")],
		`grantRole(InstantLayer, SIGNER_SETTER_ROLE) on AccountLayer`,
	)
	push(
		accountLayerDiamondAddress,
		alControlFacetIface,
		"setWhitelistedSymmioCore",
		[diamondAddress, true],
		`setWhitelistedSymmioCore(Diamond, true) on AccountLayer`,
	)

	// On InstantLayer
	push(instantLayerAddress, instantLayerIface, "setAccountLayer", [accountLayerDiamondAddress], `setAccountLayer(AccountLayer) on InstantLayer`)
	push(instantLayerAddress, instantLayerIface, "setTargetWhitelist", [diamondAddress, true], `setTargetWhitelist(Diamond, true) on InstantLayer`)
	push(
		instantLayerAddress,
		instantLayerIface,
		"setTargetWhitelist",
		[accountLayerDiamondAddress, true],
		`setTargetWhitelist(AccountLayer, true) on InstantLayer`,
	)

	// Register PartyBs on Diamond — only those not already registered. The caller
	// is expected to pre-filter via filterUnregisteredPartyBs so the batch doesn't
	// revert on re-run (registerPartyB reverts if already registered).
	if (partyBsForDiamond.length > 0) {
		// Grant PARTY_B_MANAGER_ROLE to the Safe so it can call registerPartyB, then
		// one call per PartyB (ControlFacet has no batch variant).
		push(
			diamondAddress,
			controlFacetIface,
			"grantRole",
			[protocolAdmin, roleHash("PARTY_B_MANAGER_ROLE")],
			`grantRole(protocolAdmin, PARTY_B_MANAGER_ROLE)`,
		)
		for (const partyB of partyBsForDiamond) {
			push(diamondAddress, controlFacetIface, "registerPartyB", [partyB], `registerPartyB(${partyB}) on Diamond`)
		}
	}

	// Register PartyBs on InstantLayer — single batched call. InstantLayer reverts
	// with EmptyArray() on empty input and PartyBAlreadyRegistered on dupes, so this
	// only fires when the filtered list is non-empty.
	if (partyBsForInstantLayer.length > 0) {
		push(
			instantLayerAddress,
			instantLayerIface,
			"registerPartyBs",
			[partyBsForInstantLayer],
			`registerPartyBs([${partyBsForInstantLayer.length} partyBs]) on InstantLayer`,
		)
	}

	return txs
}

// ============================================================================
// Deploy SymmioSymbolManager
// ============================================================================

export type SymbolManagerDeployResult = {
	address: string
}

export async function deploySymbolManager(
	diamondAddress: string,
	protocolAdmin: string,
	stateFile?: string,
	stateContext?: DeploymentStateContext,
): Promise<SymbolManagerDeployResult> {
	const metadata = stateFile ? await resolveDeploymentStateMetadata({ diamondAddress, ...stateContext }) : undefined
	const state = loadDeploymentState<DeployedState>(stateFile ?? "", metadata)

	if (state.symbolManager?.address) {
		await requireDeployedCode("SymmioSymbolManager", state.symbolManager.address)
		const existing = await ethers.getContractAt("SymmioSymbolManager", state.symbolManager.address)
		const boundDiamond = ethers.getAddress(await existing.symmioAddress())
		const expectedDiamond = ethers.getAddress(diamondAddress)
		if (boundDiamond !== expectedDiamond) {
			throw new Error(`Stored SymmioSymbolManager ${state.symbolManager.address} targets ${boundDiamond}, expected ${expectedDiamond}`)
		}
		log.deployed("SymmioSymbolManager", state.symbolManager.address, true)
		return { address: state.symbolManager.address }
	}

	const factory = await ethers.getContractFactory("SymmioSymbolManager")
	const contract = await factory.deploy(diamondAddress, protocolAdmin, deployTxOverrides())
	const address = await contract.getAddress()
	await contract.waitForDeployment()
	await requireDeployedCode("SymmioSymbolManager", address)

	if (!state.symbolManager) state.symbolManager = {}
	state.symbolManager.address = address
	if (stateFile) saveState(stateFile, state, metadata)

	log.deployed("SymmioSymbolManager", address)
	return { address }
}

// ============================================================================
// Wire SymmioSymbolManager to Diamond (EOA path)
// ============================================================================

export async function wireSymbolManager(diamondAddress: string, symbolManagerAddress: string, adminSigner: any): Promise<void> {
	const roleHash = (name: string) => ethers.id(name)
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress, adminSigner)

	await (await controlFacet.grantRole(symbolManagerAddress, roleHash("SYMBOL_MANAGER_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(SymbolManager, SYMBOL_MANAGER_ROLE)")
	await (await controlFacet.grantRole(symbolManagerAddress, roleHash("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE"), writeTxOverrides())).wait()
	log.ok("grantRole(SymbolManager, FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE)")
}

// ============================================================================
// Build SymmioSymbolManager wiring transactions for Safe path
// ============================================================================

export function buildSymbolManagerWiringTransactions(diamondAddress: string, symbolManagerAddress: string): WiringTransaction[] {
	const roleHash = (name: string) => ethers.id(name)
	const txs: WiringTransaction[] = []

	const controlFacetIface = new ethers.Interface(["function grantRole(address account, bytes32 role)"])

	const push = (to: string, iface: Interface, methodName: string, args: any[], description: string) => {
		txs.push({
			to,
			value: "0",
			calldata: iface.encodeFunctionData(methodName, args),
			description,
			iface,
			methodName,
			args,
		})
	}

	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[symbolManagerAddress, roleHash("SYMBOL_MANAGER_ROLE")],
		`grantRole(SymbolManager, SYMBOL_MANAGER_ROLE)`,
	)
	push(
		diamondAddress,
		controlFacetIface,
		"grantRole",
		[symbolManagerAddress, roleHash("FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE")],
		`grantRole(SymbolManager, FORCE_CLOSE_GAP_RATIO_ADMIN_ROLE)`,
	)

	return txs
}

// ============================================================================
// Build InstantLayer template transactions for Safe path
// ============================================================================

export function buildTemplateTransactions(instantLayerAddress: string, configFile?: string): WiringTransaction[] {
	const templates = loadTemplates(configFile)
	const txs: WiringTransaction[] = []

	const iface = new ethers.Interface([
		"function addTemplate(string name, tuple(uint256[] insertionPoints, uint256[] sourceIndices, uint256[] sourceOffsets)[] operations)",
	])

	for (const template of templates) {
		txs.push({
			to: instantLayerAddress,
			value: "0",
			calldata: iface.encodeFunctionData("addTemplate", [template.name, template.operations]),
			description: `addTemplate("${template.name}", ${template.operations.length} ops) on InstantLayer`,
			iface,
			methodName: "addTemplate",
			args: [template.name, template.operations],
		})
	}

	return txs
}
