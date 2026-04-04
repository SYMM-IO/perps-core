/**
 * Deploy and wire AccountLayer Diamond + InstantLayer for the v0.8.5 upgrade.
 *
 * These contracts are new in v0.8.5 and must be deployed fresh during the upgrade.
 */
import fs from "fs"
import path from "path"

import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"

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
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir: string): void {
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function loadState(filePath: string): DeployedState {
	if (!filePath || !fs.existsSync(filePath)) return {}
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DeployedState
}

function saveState(filePath: string, state: DeployedState): void {
	if (!filePath) return
	ensureDir(path.dirname(filePath))
	fs.writeFileSync(filePath, JSON.stringify(state, null, 2))
}

// ============================================================================
// Deploy AccountLayer Diamond
// ============================================================================

export async function deployAccountLayerDiamond(
	protocolAdmin: string,
	symmioFeeReceiver: string,
	stateFile?: string,
	adminSigner?: any,
): Promise<AccountLayerDeployResult> {
	const state = loadState(stateFile ?? "")
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
		const contract = await factory.deploy()
		diamondCutFacetAddress = await contract.getAddress()
		al.diamondCutFacet = diamondCutFacetAddress
		if (stateFile) saveState(stateFile, state)
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
		const contract = await factory.deploy(deployOwner, diamondCutFacetAddress)
		diamondAddress = await contract.getAddress()
		al.diamond = diamondAddress
		if (stateFile) saveState(stateFile, state)
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
		const contract = await factory.deploy()
		initAddress = await contract.getAddress()
		al.init = initAddress
		if (stateFile) saveState(stateFile, state)
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
		const contract = await factory.deploy()
		libraryAddresses["LibQuoteParams"] = await contract.getAddress()
		al.libraries["LibQuoteParams"] = libraryAddresses["LibQuoteParams"]
		if (stateFile) saveState(stateFile, state)
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
			const facet = await factory.deploy()
			// Save address immediately after tx is submitted (before mining) so a crash
			// during waitForDeployment doesn't lose the deployed address and cause a
			// nonce-too-low error on retry.
			facetAddress = await facet.getAddress()
			facetAddresses[facetName] = facetAddress
			al.facets[facetName] = facetAddress
			if (stateFile) saveState(stateFile, state)
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
				const tx = await diamondCutContract.diamondCut(chunk, initTarget, initData)
				const receipt = await tx.wait()
				if (!receipt?.status) {
					throw new Error(`AccountLayer diamond cut failed in chunk ${chunkNum}/${totalChunks}`)
				}
				log.ok(`Diamond cut chunk ${chunkNum}/${totalChunks} applied`)
			}
		}

		al.diamondCutComplete = true
		if (stateFile) saveState(stateFile, state)
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

export async function deployInstantLayer(symmioAddress: string, protocolAdmin: string, stateFile?: string): Promise<InstantLayerDeployResult> {
	const state = loadState(stateFile ?? "")

	if (state.instantLayer?.address) {
		log.deployed("InstantLayer", state.instantLayer.address, true)
		return { address: state.instantLayer.address }
	}

	const factory = await ethers.getContractFactory("InstantLayer")
	const contract = await factory.deploy(symmioAddress, protocolAdmin)
	const address = await contract.getAddress()

	if (!state.instantLayer) state.instantLayer = {}
	state.instantLayer.address = address
	if (stateFile) saveState(stateFile, state)

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
	await (await controlFacet.grantRole(adminAddress, roleHash("INTEGRATION_ADMIN_ROLE"))).wait()

	// Grant roles to AccountLayer on Diamond
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("SIGNER_ADMIN_ROLE"))).wait()
	log.ok("grantRole(AccountLayer, SIGNER_ADMIN_ROLE)")
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("AFFILIATE_MANAGER_ROLE"))).wait()
	log.ok("grantRole(AccountLayer, AFFILIATE_MANAGER_ROLE)")
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("BALANCE_SETTLER_ROLE"))).wait()
	log.ok("grantRole(AccountLayer, BALANCE_SETTLER_ROLE)")

	// Grant InstantLayer role on Diamond
	await (await controlFacet.grantRole(instantLayerAddress, roleHash("INSTANT_LAYER_ROLE"))).wait()
	log.ok("grantRole(InstantLayer, INSTANT_LAYER_ROLE)")

	// Register AccountLayer as system hook on Diamond
	await (await controlFacet.registerHook(ethers.ZeroAddress, accountLayerDiamondAddress)).wait()
	log.ok("registerHook(address(0), AccountLayer)")

	// AccountLayer Diamond ControlFacet
	const alControlFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		accountLayerDiamondAddress,
		adminSigner,
	)

	// Grant InstantLayer SIGNER_SETTER_ROLE on AccountLayer
	await (await alControlFacet.grantRole(instantLayerAddress, roleHash("SIGNER_SETTER_ROLE"))).wait()
	log.ok("grantRole(InstantLayer, SIGNER_SETTER_ROLE) on AccountLayer")

	// Whitelist Symmio Core on AccountLayer
	await (await alControlFacet.setWhitelistedSymmioCore(diamondAddress, true)).wait()
	log.ok("setWhitelistedSymmioCore(Diamond, true)")

	// InstantLayer configuration
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)

	// Set AccountLayer on InstantLayer
	await (await instantLayer.setAccountLayer(accountLayerDiamondAddress)).wait()
	log.ok("setAccountLayer(AccountLayer)")

	// Whitelist Diamond and AccountLayer on InstantLayer
	await (await instantLayer.setTargetWhitelist(diamondAddress, true)).wait()
	log.ok("setTargetWhitelist(Diamond, true)")
	await (await instantLayer.setTargetWhitelist(accountLayerDiamondAddress, true)).wait()
	log.ok("setTargetWhitelist(AccountLayer, true)")
}

// ============================================================================
// Setup InstantLayer Templates
// ============================================================================

export async function setupInstantLayerTemplates(instantLayerAddress: string, adminSigner: any): Promise<void> {
	log.info("Templates:")

	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)

	// InstantOpen Template (4 operations)
	const instantOpenOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: addMarginToNextVA
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: sendQuote
		{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // op 2: lockQuote - quoteId from op 1
		{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // op 3: openPosition - quoteId from op 1
	]
	await (await instantLayer.addTemplate("InstantOpen", instantOpenOps)).wait()
	log.ok("InstantOpen (4 ops)")

	// InstantClose Template (2 operations)
	const instantCloseOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: requestToClosePosition
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: fillCloseRequest
	]
	await (await instantLayer.addTemplate("InstantClose", instantCloseOps)).wait()
	log.ok("InstantClose (2 ops)")

	// InstantCloseWithAllocation Template (3 operations)
	const instantCloseWithAllocationOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 2
	]
	await (await instantLayer.addTemplate("InstantCloseWithAllocation", instantCloseWithAllocationOps)).wait()
	log.ok("InstantCloseWithAllocation (3 ops)")
}

// ============================================================================
// Build wiring transactions for Safe path
// ============================================================================

export type WiringTransaction = {
	to: string
	value: string
	calldata: string
	description: string
}

export function buildWiringTransactions(
	diamondAddress: string,
	accountLayerDiamondAddress: string,
	instantLayerAddress: string,
	protocolAdmin: string,
	symmioPartyBAddress?: string,
	symmioPartyBImplementation?: string,
): WiringTransaction[] {
	const roleHash = (name: string) => ethers.id(name)
	const txs: WiringTransaction[] = []

	// ABIs for encoding
	const controlFacetIface = new ethers.Interface([
		"function grantRole(address account, bytes32 role)",
		"function registerHook(address affiliate, address hook)",
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

	// On core Diamond
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("grantRole", [protocolAdmin, roleHash("INTEGRATION_ADMIN_ROLE")]),
		description: `grantRole(protocolAdmin, INTEGRATION_ADMIN_ROLE)`,
	})
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("grantRole", [accountLayerDiamondAddress, roleHash("SIGNER_ADMIN_ROLE")]),
		description: `grantRole(AccountLayer, SIGNER_ADMIN_ROLE)`,
	})
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("grantRole", [accountLayerDiamondAddress, roleHash("AFFILIATE_MANAGER_ROLE")]),
		description: `grantRole(AccountLayer, AFFILIATE_MANAGER_ROLE)`,
	})
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("grantRole", [accountLayerDiamondAddress, roleHash("BALANCE_SETTLER_ROLE")]),
		description: `grantRole(AccountLayer, BALANCE_SETTLER_ROLE)`,
	})
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("grantRole", [instantLayerAddress, roleHash("INSTANT_LAYER_ROLE")]),
		description: `grantRole(InstantLayer, INSTANT_LAYER_ROLE)`,
	})
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("registerHook", [ethers.ZeroAddress, accountLayerDiamondAddress]),
		description: `registerHook(address(0), AccountLayer)`,
	})

	// On AccountLayer Diamond
	txs.push({
		to: accountLayerDiamondAddress,
		value: "0",
		calldata: alControlFacetIface.encodeFunctionData("grantRole", [instantLayerAddress, roleHash("SIGNER_SETTER_ROLE")]),
		description: `grantRole(InstantLayer, SIGNER_SETTER_ROLE) on AccountLayer`,
	})
	txs.push({
		to: accountLayerDiamondAddress,
		value: "0",
		calldata: alControlFacetIface.encodeFunctionData("setWhitelistedSymmioCore", [diamondAddress, true]),
		description: `setWhitelistedSymmioCore(Diamond, true) on AccountLayer`,
	})

	// On InstantLayer
	txs.push({
		to: instantLayerAddress,
		value: "0",
		calldata: instantLayerIface.encodeFunctionData("setAccountLayer", [accountLayerDiamondAddress]),
		description: `setAccountLayer(AccountLayer) on InstantLayer`,
	})
	txs.push({
		to: instantLayerAddress,
		value: "0",
		calldata: instantLayerIface.encodeFunctionData("setTargetWhitelist", [diamondAddress, true]),
		description: `setTargetWhitelist(Diamond, true) on InstantLayer`,
	})
	txs.push({
		to: instantLayerAddress,
		value: "0",
		calldata: instantLayerIface.encodeFunctionData("setTargetWhitelist", [accountLayerDiamondAddress, true]),
		description: `setTargetWhitelist(AccountLayer, true) on InstantLayer`,
	})

	// SymmioPartyB: register on InstantLayer
	if (symmioPartyBAddress) {
		txs.push({
			to: instantLayerAddress,
			value: "0",
			calldata: instantLayerIface.encodeFunctionData("registerPartyBs", [[symmioPartyBAddress]]),
			description: `registerPartyBs([SymmioPartyB]) on InstantLayer`,
		})
	}

	return txs
}
