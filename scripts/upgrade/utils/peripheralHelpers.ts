/**
 * Deploy and wire AccountLayer Diamond + InstantLayer for the v0.8.5 upgrade.
 *
 * These contracts are new in v0.8.5 and must be deployed fresh during the upgrade.
 */
import fs from "fs"
import path from "path"

import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"
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
		log.deployed("DiamondCutFacet", diamondCutFacetAddress, true)
	} else {
		const factory = await ethers.getContractFactory("DiamondCutFacet")
		const contract = await factory.deploy(deployTxOverrides())
		diamondCutFacetAddress = await contract.getAddress()
		al.diamondCutFacet = diamondCutFacetAddress
		if (stateFile) saveState(stateFile, state, metadata)
		await contract.waitForDeployment()
		log.deployed("DiamondCutFacet", diamondCutFacetAddress)
	}

	// 2. Diamond proxy — deployed with deployer as owner so this script can
	//    call diamondCut directly. The Init grants DEFAULT_ADMIN_ROLE to
	//    protocolAdmin for role-based governance.
	const [deployer] = await ethers.getSigners()

	let diamondAddress: string
	if (al.diamond) {
		diamondAddress = al.diamond
		log.deployed("Diamond", diamondAddress, true)
	} else {
		const factory = await ethers.getContractFactory("Diamond")
		const deployOwner = adminSigner ? protocolAdmin : await deployer.getAddress()
		const contract = await factory.deploy(deployOwner, diamondCutFacetAddress, deployTxOverrides())
		diamondAddress = await contract.getAddress()
		al.diamond = diamondAddress
		if (stateFile) saveState(stateFile, state, metadata)
		await contract.waitForDeployment()
		log.deployed("Diamond", diamondAddress)
	}

	// 3. Init contract
	let initAddress: string
	if (al.init) {
		initAddress = al.init
		log.deployed("Init", initAddress, true)
	} else {
		const factory = await ethers.getContractFactory("contracts/accountLayer/Init.sol:Init")
		const contract = await factory.deploy(deployTxOverrides())
		initAddress = await contract.getAddress()
		al.init = initAddress
		if (stateFile) saveState(stateFile, state, metadata)
		await contract.waitForDeployment()
		log.deployed("Init", initAddress)
	}

	// 4. LibQuoteParams library
	if (!al.libraries) al.libraries = {}
	const libraryAddresses: Record<string, string> = { ...al.libraries }

	if (libraryAddresses["LibQuoteParams"]) {
		log.deployed("LibQuoteParams", libraryAddresses["LibQuoteParams"], true)
	} else {
		const factory = await ethers.getContractFactory("contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams")
		const contract = await factory.deploy(deployTxOverrides())
		libraryAddresses["LibQuoteParams"] = await contract.getAddress()
		al.libraries["LibQuoteParams"] = libraryAddresses["LibQuoteParams"]
		if (stateFile) saveState(stateFile, state, metadata)
		await contract.waitForDeployment()
		log.deployed("LibQuoteParams", libraryAddresses["LibQuoteParams"])
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
			// Save address immediately after tx is submitted (before mining) so a crash
			// during waitForDeployment doesn't lose the deployed address and cause a
			// nonce-too-low error on retry.
			facetAddress = await facet.getAddress()
			facetAddresses[facetName] = facetAddress
			al.facets[facetName] = facetAddress
			if (stateFile) saveState(stateFile, state, metadata)
			await facet.waitForDeployment()
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

	// 6. Apply diamond cut with Init
	if (al.diamondCutComplete) {
		log.ok("Diamond cut already complete (cached)")
	} else {
		// Verify on-chain: try calling admin() from AccountLayer ControlFacet
		let alreadyDone = false
		try {
			const controlFacet = await ethers.getContractAt(AccountLayerFacetPathMap["ControlFacet"], diamondAddress)
			await controlFacet.admin()
			alreadyDone = true
			log.ok("Diamond cut already complete (verified on-chain)")
		} catch {
			// Not done yet
		}

		if (!alreadyDone) {
			const diamondCutContract = await ethers.getContractAt("IDiamondCut", diamondAddress, adminSigner)
			const init = await ethers.getContractAt("contracts/accountLayer/Init.sol:Init", initAddress)

			// Get AccountManager bytecode for Init
			const accountManagerFactory = await ethers.getContractFactory("contracts/accountLayer/AccountManager.sol:AccountManager")
			const accountManagerBytecode = accountManagerFactory.bytecode

			const initCalldata = init.interface.encodeFunctionData("init", [protocolAdmin, symmioFeeReceiver, accountManagerBytecode])

			const chunkSize = 3
			const totalChunks = Math.ceil(cut.length / chunkSize)
			for (let i = 0; i < cut.length; i += chunkSize) {
				const chunk = cut.slice(i, i + chunkSize)
				const chunkNum = Math.floor(i / chunkSize) + 1
				const isFirst = i === 0
				const initTarget = isFirst ? initAddress : ethers.ZeroAddress
				const initData = isFirst ? initCalldata : "0x"
				const tx = await diamondCutContract.diamondCut(chunk, initTarget, initData, accountLayerCutTxOverrides())
				const receipt = await tx.wait()
				if (!receipt?.status) {
					throw new Error(`AccountLayer diamond cut failed in chunk ${chunkNum}/${totalChunks}`)
				}
				log.ok(`Diamond cut chunk ${chunkNum}/${totalChunks} applied`)
			}
		}

		al.diamondCutComplete = true
		if (stateFile) saveState(stateFile, state, metadata)
	}

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
		log.deployed("InstantLayer", state.instantLayer.address, true)
		return { address: state.instantLayer.address }
	}

	const factory = await ethers.getContractFactory("InstantLayer")
	const contract = await factory.deploy(symmioAddress, protocolAdmin, deployTxOverrides())
	const address = await contract.getAddress()

	if (!state.instantLayer) state.instantLayer = {}
	state.instantLayer.address = address
	if (stateFile) saveState(stateFile, state, metadata)

	await contract.waitForDeployment()
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
	const config = JSON.parse(fs.readFileSync(file, "utf-8")) as { templates: TemplateConfig[] }
	if (!config.templates || config.templates.length === 0) {
		throw new Error(`No templates defined in ${file}`)
	}
	return config.templates
}

export async function setupInstantLayerTemplates(instantLayerAddress: string, adminSigner: any, configFile?: string): Promise<void> {
	log.info("Templates:")

	const templates = loadTemplates(configFile)
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)

	for (const template of templates) {
		await (await instantLayer.addTemplate(template.name, template.operations, writeTxOverrides())).wait()
		log.ok(`${template.name} (${template.operations.length} ops)`)
	}
}

// ============================================================================
// Build wiring transactions for Safe path
// ============================================================================

export type WiringTransaction = {
	to: string
	value: string
	calldata: string
	description: string
	iface: ethers.Interface
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
	provider: ethers.Provider,
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
		const onDiamond: boolean | null = diamond ? await diamond.isPartyB(addr) : null
		const onInstantLayer: boolean | null = il ? await il.registeredPartyBs(addr) : null
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
	const push = (to: string, iface: ethers.Interface, methodName: string, args: any[], description: string) => {
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
		log.deployed("SymmioSymbolManager", state.symbolManager.address, true)
		return { address: state.symbolManager.address }
	}

	const factory = await ethers.getContractFactory("SymmioSymbolManager")
	const contract = await factory.deploy(diamondAddress, protocolAdmin, deployTxOverrides())
	const address = await contract.getAddress()

	if (!state.symbolManager) state.symbolManager = {}
	state.symbolManager.address = address
	if (stateFile) saveState(stateFile, state, metadata)

	await contract.waitForDeployment()
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

	const push = (to: string, iface: ethers.Interface, methodName: string, args: any[], description: string) => {
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
