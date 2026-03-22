/**
 * Deploy and wire AccountLayer Diamond + InstantLayer for the v0.8.5 upgrade.
 *
 * These contracts are new in v0.8.5 and must be deployed fresh during the upgrade.
 */
import fs from "fs"
import path from "path"

import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"

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
	adminAddress: string,
	symmioFeeReceiver: string,
	stateFile?: string,
): Promise<AccountLayerDeployResult> {
	const state = loadState(stateFile ?? "")
	if (!state.accountLayer) state.accountLayer = {}
	const al = state.accountLayer

	console.log("  Deploying AccountLayer Diamond...")

	// 1. DiamondCutFacet
	let diamondCutFacetAddress: string
	if (al.diamondCutFacet) {
		diamondCutFacetAddress = al.diamondCutFacet
		console.log(`    DiamondCutFacet: ${diamondCutFacetAddress} (cached)`)
	} else {
		const factory = await ethers.getContractFactory("DiamondCutFacet")
		const contract = await factory.deploy()
		await contract.waitForDeployment()
		diamondCutFacetAddress = await contract.getAddress()
		al.diamondCutFacet = diamondCutFacetAddress
		if (stateFile) saveState(stateFile, state)
		console.log(`    DiamondCutFacet: ${diamondCutFacetAddress}`)
	}

	// 2. Diamond proxy
	let diamondAddress: string
	if (al.diamond) {
		diamondAddress = al.diamond
		console.log(`    Diamond: ${diamondAddress} (cached)`)
	} else {
		const factory = await ethers.getContractFactory("Diamond")
		const contract = await factory.deploy(adminAddress, diamondCutFacetAddress)
		await contract.waitForDeployment()
		diamondAddress = await contract.getAddress()
		al.diamond = diamondAddress
		if (stateFile) saveState(stateFile, state)
		console.log(`    Diamond: ${diamondAddress}`)
	}

	// 3. Init contract
	let initAddress: string
	if (al.init) {
		initAddress = al.init
		console.log(`    Init: ${initAddress} (cached)`)
	} else {
		const factory = await ethers.getContractFactory("contracts/accountLayer/Init.sol:Init")
		const contract = await factory.deploy()
		await contract.waitForDeployment()
		initAddress = await contract.getAddress()
		al.init = initAddress
		if (stateFile) saveState(stateFile, state)
		console.log(`    Init: ${initAddress}`)
	}

	// 4. LibQuoteParams library
	if (!al.libraries) al.libraries = {}
	const libraryAddresses: Record<string, string> = { ...al.libraries }

	if (libraryAddresses["LibQuoteParams"]) {
		console.log(`    LibQuoteParams: ${libraryAddresses["LibQuoteParams"]} (cached)`)
	} else {
		const factory = await ethers.getContractFactory("contracts/accountLayer/libraries/LibQuoteParams.sol:LibQuoteParams")
		const contract = await factory.deploy()
		await contract.waitForDeployment()
		libraryAddresses["LibQuoteParams"] = await contract.getAddress()
		al.libraries["LibQuoteParams"] = libraryAddresses["LibQuoteParams"]
		if (stateFile) saveState(stateFile, state)
		console.log(`    LibQuoteParams: ${libraryAddresses["LibQuoteParams"]}`)
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
			console.log(`    [${i + 1}/${AccountLayerFacetNames.length}] ${facetName}: ${facetAddress} (cached)`)
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
			await facet.waitForDeployment()
			facetAddress = await facet.getAddress()
			facetAddresses[facetName] = facetAddress
			al.facets[facetName] = facetAddress
			if (stateFile) saveState(stateFile, state)
			console.log(`    [${i + 1}/${AccountLayerFacetNames.length}] ${facetName}: ${facetAddress}`)
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
		console.log("    Diamond cut already complete (cached)")
	} else {
		// Verify on-chain: try calling admin() from AccountLayer ControlFacet
		let alreadyDone = false
		try {
			const controlFacet = await ethers.getContractAt(AccountLayerFacetPathMap["ControlFacet"], diamondAddress)
			await controlFacet.admin()
			alreadyDone = true
			console.log("    Diamond cut already complete (verified on-chain)")
		} catch {
			// Not done yet
		}

		if (!alreadyDone) {
			const diamondCutContract = await ethers.getContractAt("IDiamondCut", diamondAddress)
			const init = await ethers.getContractAt("contracts/accountLayer/Init.sol:Init", initAddress)

			// Get AccountManager bytecode for Init
			const accountManagerFactory = await ethers.getContractFactory("contracts/accountLayer/AccountManager.sol:AccountManager")
			const accountManagerBytecode = accountManagerFactory.bytecode

			const initCalldata = init.interface.encodeFunctionData("init", [adminAddress, symmioFeeReceiver, accountManagerBytecode])

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
				console.log(`    Diamond cut chunk ${chunkNum}/${totalChunks} applied`)
			}
		}

		al.diamondCutComplete = true
		if (stateFile) saveState(stateFile, state)
	}

	console.log(`  AccountLayer Diamond deployed: ${diamondAddress}`)

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

export async function deployInstantLayer(symmioAddress: string, adminAddress: string, stateFile?: string): Promise<InstantLayerDeployResult> {
	const state = loadState(stateFile ?? "")

	if (state.instantLayer?.address) {
		console.log(`  InstantLayer: ${state.instantLayer.address} (cached)`)
		return { address: state.instantLayer.address }
	}

	console.log("  Deploying InstantLayer...")
	const factory = await ethers.getContractFactory("InstantLayer")
	const contract = await factory.deploy(symmioAddress, adminAddress)
	await contract.waitForDeployment()
	const address = await contract.getAddress()

	if (!state.instantLayer) state.instantLayer = {}
	state.instantLayer.address = address
	if (stateFile) saveState(stateFile, state)

	console.log(`  InstantLayer deployed: ${address}`)
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
	console.log("  Wiring AccountLayer + InstantLayer...")

	const roleHash = (name: string) => ethers.id(name)
	const adminAddress = await adminSigner.getAddress()

	// Core Diamond ControlFacet
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress, adminSigner)

	// Grant INTEGRATION_ADMIN_ROLE to admin (needed for registerHook)
	await (await controlFacet.grantRole(adminAddress, roleHash("INTEGRATION_ADMIN_ROLE"))).wait()

	// Grant roles to AccountLayer on Diamond
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("SIGNER_ADMIN_ROLE"))).wait()
	console.log("    grantRole(AccountLayer, SIGNER_ADMIN_ROLE)")
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("AFFILIATE_MANAGER_ROLE"))).wait()
	console.log("    grantRole(AccountLayer, AFFILIATE_MANAGER_ROLE)")
	await (await controlFacet.grantRole(accountLayerDiamondAddress, roleHash("BALANCE_SETTLER_ROLE"))).wait()
	console.log("    grantRole(AccountLayer, BALANCE_SETTLER_ROLE)")

	// Grant InstantLayer role on Diamond
	await (await controlFacet.grantRole(instantLayerAddress, roleHash("INSTANT_LAYER_ROLE"))).wait()
	console.log("    grantRole(InstantLayer, INSTANT_LAYER_ROLE)")

	// Register AccountLayer as system hook on Diamond
	await (await controlFacet.registerHook(ethers.ZeroAddress, accountLayerDiamondAddress)).wait()
	console.log("    registerHook(address(0), AccountLayer)")

	// AccountLayer Diamond ControlFacet
	const alControlFacet = await ethers.getContractAt(
		"contracts/accountLayer/facets/Control/ControlFacet.sol:ControlFacet",
		accountLayerDiamondAddress,
		adminSigner,
	)

	// Grant InstantLayer SIGNER_SETTER_ROLE on AccountLayer
	await (await alControlFacet.grantRole(instantLayerAddress, roleHash("SIGNER_SETTER_ROLE"))).wait()
	console.log("    grantRole(InstantLayer, SIGNER_SETTER_ROLE) on AccountLayer")

	// Whitelist Symmio Core on AccountLayer
	await (await alControlFacet.setWhitelistedSymmioCore(diamondAddress, true)).wait()
	console.log("    setWhitelistedSymmioCore(Diamond, true)")

	// InstantLayer configuration
	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)

	// Set AccountLayer on InstantLayer
	await (await instantLayer.setAccountLayer(accountLayerDiamondAddress)).wait()
	console.log("    setAccountLayer(AccountLayer)")

	// Whitelist Diamond and AccountLayer on InstantLayer
	await (await instantLayer.setTargetWhitelist(diamondAddress, true)).wait()
	console.log("    setTargetWhitelist(Diamond, true)")
	await (await instantLayer.setTargetWhitelist(accountLayerDiamondAddress, true)).wait()
	console.log("    setTargetWhitelist(AccountLayer, true)")

	console.log("  Wiring complete.")
}

// ============================================================================
// Setup InstantLayer Templates
// ============================================================================

export async function setupInstantLayerTemplates(instantLayerAddress: string, adminSigner: any): Promise<void> {
	console.log("  Setting up InstantLayer templates...")

	const instantLayer = await ethers.getContractAt("InstantLayer", instantLayerAddress, adminSigner)

	// InstantOpen Template (4 operations)
	const instantOpenOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: addMarginToNextVA
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: sendQuote
		{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // op 2: lockQuote - quoteId from op 1
		{ sourceIndices: [1], insertionPoints: [0], sourceOffsets: [0] }, // op 3: openPosition - quoteId from op 1
	]
	await (await instantLayer.addTemplate("InstantOpen", instantOpenOps)).wait()
	console.log("    InstantOpen template added")

	// InstantClose Template (2 operations)
	const instantCloseOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0: requestToClosePosition
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1: fillCloseRequest
	]
	await (await instantLayer.addTemplate("InstantClose", instantCloseOps)).wait()
	console.log("    InstantClose template added")

	// InstantCloseWithAllocation Template (3 operations)
	const instantCloseWithAllocationOps = [
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 0
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 1
		{ sourceIndices: [], insertionPoints: [], sourceOffsets: [] }, // op 2
	]
	await (await instantLayer.addTemplate("InstantCloseWithAllocation", instantCloseWithAllocationOps)).wait()
	console.log("    InstantCloseWithAllocation template added")

	console.log("  Templates setup complete.")
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
	adminAddress: string,
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
	])

	// On core Diamond
	txs.push({
		to: diamondAddress,
		value: "0",
		calldata: controlFacetIface.encodeFunctionData("grantRole", [adminAddress, roleHash("INTEGRATION_ADMIN_ROLE")]),
		description: `grantRole(admin, INTEGRATION_ADMIN_ROLE)`,
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

	return txs
}
