/**
 * Diamond upgrade utilities — deploy facets, build diamondCut, apply it.
 * Extracted from upgradeTest.ts for use by forkUpgrade.ts.
 */
import fs from "fs"

import { FacetNames } from "../../../tasks/deploy/constants.js"
import { FacetCutAction, getSelectors } from "../../../tasks/utils/diamondCut.js"
import { ethers } from "../../../test/helpers/hardhat-connection.js"
import { log } from "./log.js"

export type FacetInfo = {
	address: string
	selectors: string[]
}

export type SelectorChangeAction = "add" | "replace" | "remove"

export type SelectorChange = {
	selector: string
	action: SelectorChangeAction
	signature: string | null
	fromFacetAddress: string | null
	toFacetAddress: string | null
	toFacetName: string | null
}

const IGNORE_REMOVE_SELECTORS = new Set<string>([
	"0x1f931c1c", // diamondCut
])

// Facet => required libraries for linking
export const FacetLibraryDependencies: Record<string, string[]> = {
	PartyAFacet: ["LibQuoteClose"],
	PartyBPositionActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBBatchActionsFacet: ["LibQuoteClose", "LibQuoteFunding"],
	PartyBEmergencyActionsFacet: ["LibQuoteClose"],
	PartyBQuoteActionsFacet: ["LibQuoteClose"],
	ForceActionsFacet: ["LibForceActions", "LibSettlement"],
	ForceCloseStepsFacet: ["LibForceActions", "LibSettlement"],
	ViewFacetQuote: ["LibQuoteFunding"],
	FundingRateFacet: ["LibQuoteFunding"],
	PartyALiquidationFacet: ["LibQuoteFunding"],
	ClearingHouseFacet: ["LibQuoteFunding"],
	SettlementFacet: ["LibSettlement"],
}

export async function deployLibraries(): Promise<Record<string, string>> {
	const libraries: Record<string, string> = {}

	const LibQuoteFundingFactory = await ethers.getContractFactory("LibQuoteFunding")
	const libQuoteFunding = await LibQuoteFundingFactory.deploy()
	await libQuoteFunding.waitForDeployment()
	libraries.LibQuoteFunding = await libQuoteFunding.getAddress()

	const LibQuoteCloseFactory = await ethers.getContractFactory("LibQuoteClose", {
		libraries: {
			"project/contracts/core/libraries/LibQuoteFunding.sol:LibQuoteFunding": libraries.LibQuoteFunding,
		},
	})
	const libQuoteClose = await LibQuoteCloseFactory.deploy()
	await libQuoteClose.waitForDeployment()
	libraries.LibQuoteClose = await libQuoteClose.getAddress()

	const LibForceActionsFactory = await ethers.getContractFactory("LibForceActions", {
		libraries: {
			"project/contracts/core/libraries/LibQuoteClose.sol:LibQuoteClose": libraries.LibQuoteClose,
		},
	})
	const libForceActions = await LibForceActionsFactory.deploy()
	await libForceActions.waitForDeployment()
	libraries.LibForceActions = await libForceActions.getAddress()

	const LibSettlementFactory = await ethers.getContractFactory("LibSettlement")
	const libSettlement = await LibSettlementFactory.deploy()
	await libSettlement.waitForDeployment()
	libraries.LibSettlement = await libSettlement.getAddress()

	return libraries
}

export async function deployFacets(outputFile?: string): Promise<{ facets: Record<string, FacetInfo>; selectorSignatures: Record<string, string> }> {
	// Load previously deployed facets/libraries to resume after failures
	let partial: { libraries?: Record<string, string>; facets?: Record<string, FacetInfo>; selectorSignatures?: Record<string, string> } = {}
	if (outputFile && fs.existsSync(outputFile)) {
		try {
			partial = JSON.parse(fs.readFileSync(outputFile, "utf-8"))
			const deployed = Object.keys(partial.facets ?? {})
			if (deployed.length > 0) {
				log.info(`Resuming: ${deployed.length}/${FacetNames.length} facets already deployed`)
			}
		} catch {
			partial = {}
		}
	}

	let libraries: Record<string, string> = partial.libraries ?? {}
	const facets: Record<string, FacetInfo> = partial.facets ?? {}
	const selectorSignatures: Record<string, string> = partial.selectorSignatures ?? {}

	const save = () => {
		if (!outputFile) return
		const dir = outputFile.substring(0, outputFile.lastIndexOf("/"))
		if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(outputFile, JSON.stringify({ libraries, facets, selectorSignatures }, null, 2))
	}

	// Deploy or reuse libraries
	log.info("Libraries:")
	if (libraries.LibQuoteFunding && libraries.LibQuoteClose && libraries.LibForceActions && libraries.LibSettlement) {
		for (const [name, addr] of Object.entries(libraries)) {
			log.deployed(name, addr, true)
		}
	} else {
		libraries = await deployLibraries()
		for (const [name, addr] of Object.entries(libraries)) {
			log.deployed(name, addr)
		}
		save()
	}

	log.info(`Facets (${FacetNames.length}):`)
	let deployedCount = 0
	for (let i = 0; i < FacetNames.length; i++) {
		const facetName = FacetNames[i]
		const shortName = facetName.includes(":") ? facetName.split(":").pop()! : facetName

		if (facets[shortName]) {
			log.skipped(shortName, facets[shortName].address)
			deployedCount++
			continue
		}

		const requiredLibraries = FacetLibraryDependencies[shortName]
		let facetFactory

		if (requiredLibraries && requiredLibraries.length > 0) {
			const linked: Record<string, string> = {}
			for (const lib of requiredLibraries) {
				linked[`project/contracts/core/libraries/${lib}.sol:${lib}`] = libraries[lib]
			}
			facetFactory = await ethers.getContractFactory(facetName, { libraries: linked })
		} else {
			facetFactory = await ethers.getContractFactory(facetName)
		}

		const facet = await facetFactory.deploy()
		await facet.waitForDeployment()
		const address = await facet.getAddress()
		const selectors = getSelectors(ethers, facetFactory).selectors

		facets[shortName] = { address, selectors }
		for (const fragment of facetFactory.interface.fragments) {
			if (fragment.type !== "function") continue
			const signature = fragment.format("sighash")
			if (signature === "init(bytes)") continue
			const selector = ethers.id(signature).substring(0, 10)
			if (!selectorSignatures[selector]) {
				selectorSignatures[selector] = signature
			}
		}
		deployedCount++
		log.progress(deployedCount, FacetNames.length, `${log.name(shortName)}  ${log.addr(address)}`)
		save()
	}

	return { facets, selectorSignatures }
}

export async function buildDiamondCut(
	diamondAddress: string,
	newFacets: Record<string, FacetInfo>,
	knownSelectorSignatures: Record<string, string>,
): Promise<{ diamondCut: any[]; selectorChanges: SelectorChange[] }> {
	const diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress)
	const facets = await diamondLoupeFacet.facets()

	const currentSelectors: Map<string, string> = new Map()
	for (const facet of facets) {
		for (const selector of facet.functionSelectors) {
			currentSelectors.set(selector, facet.facetAddress)
		}
	}

	const newSelectors: Map<string, string> = new Map()
	for (const facet of Object.values(newFacets)) {
		for (const selector of facet.selectors) {
			newSelectors.set(selector, facet.address)
		}
	}

	const facetNameByAddress: Record<string, string> = {}
	for (const [facetName, facetInfo] of Object.entries(newFacets)) {
		facetNameByAddress[facetInfo.address.toLowerCase()] = facetName
	}

	const actions: Record<string, { action: FacetCutAction; facetAddress: string }> = {}
	const selectorChanges: SelectorChange[] = []

	for (const [selector, currentFacetAddress] of currentSelectors) {
		if (newSelectors.has(selector)) {
			const toFacetAddress = newSelectors.get(selector)!
			actions[selector] = {
				action: FacetCutAction.Replace,
				facetAddress: toFacetAddress,
			}
			selectorChanges.push({
				selector,
				action: "replace",
				signature: knownSelectorSignatures[selector] ?? null,
				fromFacetAddress: currentFacetAddress,
				toFacetAddress,
				toFacetName: facetNameByAddress[toFacetAddress.toLowerCase()] ?? null,
			})
			newSelectors.delete(selector)
		} else if (!IGNORE_REMOVE_SELECTORS.has(selector)) {
			actions[selector] = {
				action: FacetCutAction.Remove,
				facetAddress: ethers.ZeroAddress,
			}
			selectorChanges.push({
				selector,
				action: "remove",
				signature: knownSelectorSignatures[selector] ?? null,
				fromFacetAddress: currentFacetAddress,
				toFacetAddress: null,
				toFacetName: null,
			})
		}
	}

	for (const [selector, facetAddress] of newSelectors) {
		actions[selector] = {
			action: FacetCutAction.Add,
			facetAddress,
		}
		selectorChanges.push({
			selector,
			action: "add",
			signature: knownSelectorSignatures[selector] ?? null,
			fromFacetAddress: null,
			toFacetAddress: facetAddress,
			toFacetName: facetNameByAddress[facetAddress.toLowerCase()] ?? null,
		})
	}

	const cutMap: Record<string, { facetAddress: string; action: FacetCutAction; selectors: string[] }> = {}
	for (const [selector, info] of Object.entries(actions)) {
		const key = `${info.facetAddress}-${info.action}`
		if (!cutMap[key]) {
			cutMap[key] = {
				facetAddress: info.facetAddress,
				action: info.action,
				selectors: [],
			}
		}
		cutMap[key].selectors.push(selector)
	}

	const diamondCut = Object.values(cutMap)
		.filter(cut => cut.selectors.length > 0)
		.map(cut => ({
			facetAddress: cut.facetAddress,
			action: cut.action,
			functionSelectors: cut.selectors,
		}))

	selectorChanges.sort((a, b) => a.selector.localeCompare(b.selector))

	return {
		diamondCut,
		selectorChanges,
	}
}

export async function applyDiamondCut(diamondAddress: string, diamondCut: any[], signer?: any, chunkSize: number = 6): Promise<void> {
	if (diamondCut.length === 0) {
		log.info("No diamond cut required — already up to date")
		return
	}

	const diamondCutFacet = signer
		? await ethers.getContractAt("DiamondCutFacet", diamondAddress, signer)
		: await ethers.getContractAt("DiamondCutFacet", diamondAddress)
	const chunks: any[][] = []
	for (let i = 0; i < diamondCut.length; i += chunkSize) {
		chunks.push(diamondCut.slice(i, i + chunkSize))
	}

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]
		const selectorCount = chunk.reduce((sum: number, cut: any) => sum + cut.functionSelectors.length, 0)
		const tx = await diamondCutFacet.diamondCut(chunk, ethers.ZeroAddress, "0x")
		const receipt = await tx.wait()
		if (!receipt?.status) {
			throw new Error(`Diamond cut failed in chunk ${i + 1}/${chunks.length}: ${tx.hash}`)
		}
		log.ok(`Chunk ${i + 1}/${chunks.length} applied — ${selectorCount} selectors (tx: ${log.addr(tx.hash)})`)
	}
}

// =============================================================================
// EOA parameter setter
// =============================================================================

export const MUON_FUNCTION_NAMES = ["Trading", "AccountManagement", "Settlement", "ForceClose", "Funding", "LiquidationPartyA", "LiquidationPartyB"]

export type MuonPublicKey = {
	x: string
	parity: number
}

export type NewV085Parameters = {
	maxPartyAConnectionLimit?: number
	signatureVerifierAddress?: string
	liquidationInsuranceVault?: string
	maxLiquidationProfitPerPosition?: string
	softLiquidationPenaltyCollector?: string
	minAffiliateFee?: string
	unbindCooldown?: number
	maxWithdrawParts?: number
	minWithdrawCooldown?: number
	muonPublicKeys?: MuonPublicKey[]
	muonGatewaySigners?: string[]
	muonFunctionPermissions?: string[]
}

export async function setV085Parameters(diamondAddress: string, params: NewV085Parameters, signerOverride?: any): Promise<void> {
	const signer = signerOverride ?? (await ethers.provider.getSigner())
	const controlFacet = await ethers.getContractAt("contracts/core/facets/Control/ControlFacet.sol:ControlFacet", diamondAddress, signer)

	const signerAddress = await signer.getAddress()
	await (await controlFacet.grantRole(signerAddress, ethers.id("PROTOCOL_CONFIG_ROLE"))).wait()
	await (await controlFacet.grantRole(signerAddress, ethers.id("COOLDOWN_ADMIN_ROLE"))).wait()

	const needsFeeAdminRole =
		(params.liquidationInsuranceVault && params.maxLiquidationProfitPerPosition) || params.softLiquidationPenaltyCollector || params.minAffiliateFee
	if (needsFeeAdminRole) {
		await (await controlFacet.grantRole(signerAddress, ethers.id("FEE_ADMIN_ROLE"))).wait()
	}

	if (params.maxPartyAConnectionLimit && params.maxPartyAConnectionLimit > 0) {
		await (await controlFacet.setMaxPartyAConnectionLimit(params.maxPartyAConnectionLimit)).wait()
		log.ok(`maxPartyAConnectionLimit = ${params.maxPartyAConnectionLimit}`)
	}

	if (params.signatureVerifierAddress && ethers.isAddress(params.signatureVerifierAddress)) {
		await (await controlFacet.setSignatureVerifierAddress(params.signatureVerifierAddress)).wait()
		log.ok(`signatureVerifierAddress = ${log.addr(params.signatureVerifierAddress)}`)

		// Seed MuonSignatureVerifier with public keys and gateway signers
		const verifier = await ethers.getContractAt("MuonSignatureVerifier", params.signatureVerifierAddress, signer)

		if (params.muonPublicKeys && params.muonPublicKeys.length > 0) {
			const existingKeys = await verifier.getAllPublicKeys()
			for (const key of params.muonPublicKeys) {
				const alreadyPresent = existingKeys.some((k: any) => k.x.toString() === key.x && Number(k.parity) === key.parity)
				if (alreadyPresent) {
					log.ok(`Public key (x=${key.x.slice(0, 10)}..., parity=${key.parity}) already present`)
					continue
				}
				await (await verifier.addPublicKey({ x: key.x, parity: key.parity })).wait()
				log.ok(`addPublicKey(x=${key.x.slice(0, 10)}..., parity=${key.parity})`)
			}
		}

		if (params.muonGatewaySigners && params.muonGatewaySigners.length > 0) {
			const existingSigners = (await verifier.getAllGatewaySigners()).map((s: string) => s.toLowerCase())
			for (const gw of params.muonGatewaySigners) {
				if (existingSigners.includes(gw.toLowerCase())) {
					log.ok(`Gateway signer ${log.addr(gw)} already present`)
					continue
				}
				await (await verifier.addGatewaySigner(gw)).wait()
				log.ok(`addGatewaySigner(${log.addr(gw)})`)
			}
		}

		if (params.muonFunctionPermissions && params.muonFunctionPermissions.length > 0) {
			const functionIndices = params.muonFunctionPermissions.map(name => {
				const idx = MUON_FUNCTION_NAMES.indexOf(name)
				if (idx === -1) throw new Error(`Unknown MuonFunction: ${name}. Valid values: ${MUON_FUNCTION_NAMES.join(", ")}`)
				return idx
			})

			if (params.muonPublicKeys && params.muonPublicKeys.length > 0) {
				for (const key of params.muonPublicKeys) {
					await (await verifier.setPublicKeyPermissions({ x: key.x, parity: key.parity }, functionIndices, true)).wait()
					log.ok(`setPublicKeyPermissions(x=${key.x.slice(0, 10)}..., parity=${key.parity}, [${params.muonFunctionPermissions.join(", ")}], true)`)
				}
			}

			if (params.muonGatewaySigners && params.muonGatewaySigners.length > 0) {
				for (const gw of params.muonGatewaySigners) {
					await (await verifier.setGatewaySignerPermissions(gw, functionIndices, true)).wait()
					log.ok(`setGatewaySignerPermissions(${log.addr(gw)}, [${params.muonFunctionPermissions.join(", ")}], true)`)
				}
			}
		}
	}

	if (params.liquidationInsuranceVault && params.maxLiquidationProfitPerPosition) {
		await (await controlFacet.setLiquidationInsuranceVaultParams(params.liquidationInsuranceVault, params.maxLiquidationProfitPerPosition)).wait()
		log.ok(`liquidationInsuranceVault = ${log.addr(params.liquidationInsuranceVault)}`)
		log.ok(`maxLiquidationProfitPerPosition = ${params.maxLiquidationProfitPerPosition}`)
	}

	if (params.softLiquidationPenaltyCollector && ethers.isAddress(params.softLiquidationPenaltyCollector)) {
		await (await controlFacet.setSoftLiquidationPenaltyCollector(params.softLiquidationPenaltyCollector)).wait()
		log.ok(`softLiquidationPenaltyCollector = ${log.addr(params.softLiquidationPenaltyCollector)}`)
	}

	if (params.minAffiliateFee) {
		await (await controlFacet.setMinAffiliateFee(params.minAffiliateFee)).wait()
		log.ok(`minAffiliateFee = ${params.minAffiliateFee}`)
	}

	if (params.unbindCooldown !== undefined && params.unbindCooldown > 0) {
		await (await controlFacet.setUnbindCooldown(params.unbindCooldown)).wait()
		log.ok(`unbindCooldown = ${params.unbindCooldown}`)
	}

	if (params.minWithdrawCooldown !== undefined && params.minWithdrawCooldown > 0) {
		await (await controlFacet.setMinWithdrawCooldown(params.minWithdrawCooldown)).wait()
		log.ok(`minWithdrawCooldown = ${params.minWithdrawCooldown}`)
	}

	if (params.maxWithdrawParts !== undefined && params.maxWithdrawParts > 0) {
		await (await controlFacet.setMaxWithdrawParts(params.maxWithdrawParts)).wait()
		log.ok(`maxWithdrawParts = ${params.maxWithdrawParts}`)
	}
}

// =============================================================================
// Types for upgrade transaction generation
// =============================================================================

export type AbiInput = {
	internalType: string
	name: string
	type: string
	components?: AbiInput[]
}

export type CalldataTransaction = {
	to: string
	value: string
	calldata: string
	description: string
}

export type SafeTransaction = {
	to: string
	value: string
	data: string
	contractMethod?: {
		inputs: AbiInput[]
		name: string
		payable: boolean
	}
	contractInputsValues?: Record<string, string>
}

export type SafeBatch = {
	version: string
	chainId: string
	createdAt: number
	meta: {
		name: string
		description: string
		txBuilderVersion: string
		createdFromSafeAddress: string
		createdFromOwnerAddress: string
	}
	transactions: SafeTransaction[]
}

export type DiamondCutCalldata = {
	calldata: string
	description: string
}

export type DeployedFacets = {
	facets: Record<string, FacetInfo>
	selectorSignatures: Record<string, string>
}

export type UpgradeTransactionResult = {
	pauseSafeTxs: SafeTransaction[]
	pauseBreakdown: string[]
	safeTxs: SafeTransaction[]
	calldataTxs: CalldataTransaction[]
	diamondCutCalldataChunks: DiamondCutCalldata[]
	diamondCutInsertionIndex: number
	breakdown: string[]
	selectorChanges: SelectorChange[]
}

// =============================================================================
// ABI + Interface for upgrade transactions
// =============================================================================

const DIAMOND_ABI = [
	"function grantRole(address user, bytes32 role)",
	"function pauseGlobal()",
	"function diamondCut(tuple(address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)",
	"function setMaxPartyAConnectionLimit(uint256 maxLimit)",
	"function setSignatureVerifierAddress(address signatureVerifier)",
	"function setLiquidationInsuranceVaultParams(address insuranceVault, uint256 maxLiquidationProfit)",
	"function setSoftLiquidationPenaltyCollector(address softLiquidationPenaltyCollector)",
	"function setMinAffiliateFee(uint256 minAffiliateFee)",
	"function setUnbindCooldown(uint256 unbindCooldown)",
	"function setMaxWithdrawParts(uint256 _maxWithdrawParts)",
	"function setMinWithdrawCooldown(uint256 cooldown)",
]

const diamondIface = new ethers.Interface(DIAMOND_ABI)

// =============================================================================
// Transaction builders
// =============================================================================

function paramTypeToAbiInput(param: any): AbiInput {
	const result: AbiInput = {
		internalType: param.type,
		name: param.name,
		type: param.type,
	}
	if (param.components) {
		result.components = param.components.map(paramTypeToAbiInput)
	}
	return result
}

function argToString(value: any): string {
	if (typeof value === "bigint") return value.toString()
	if (typeof value === "number") return value.toString()
	if (Array.isArray(value)) return JSON.stringify(value)
	if (typeof value === "boolean") return value.toString()
	return String(value)
}

export function toHumanReadableSafeTxFromIface(iface: ethers.Interface, to: string, methodName: string, args: any[]): SafeTransaction {
	const fragment = iface.getFunction(methodName)
	if (!fragment) throw new Error(`Unknown method: ${methodName}`)

	const inputs = fragment.inputs.map(paramTypeToAbiInput)
	const contractInputsValues: Record<string, string> = {}
	for (let i = 0; i < fragment.inputs.length; i++) {
		contractInputsValues[fragment.inputs[i].name] = argToString(args[i])
	}

	// Include encoded calldata alongside contractMethod so Safe TX Builder can both
	// display the decoded view and fall back to raw calldata if needed.
	const data = iface.encodeFunctionData(methodName, args)

	return {
		to,
		value: "0",
		data,
		contractMethod: {
			inputs,
			name: methodName,
			payable: false,
		},
		contractInputsValues,
	}
}

export function toHumanReadableSafeTx(to: string, methodName: string, args: any[]): SafeTransaction {
	return toHumanReadableSafeTxFromIface(diamondIface, to, methodName, args)
}

function addTx(
	safeTxs: SafeTransaction[],
	calldataTxs: CalldataTransaction[],
	breakdown: string[],
	txIdx: { value: number },
	to: string,
	methodName: string,
	args: any[],
	description: string,
): void {
	safeTxs.push(toHumanReadableSafeTx(to, methodName, args))
	calldataTxs.push({
		to,
		value: "0",
		calldata: diamondIface.encodeFunctionData(methodName, args),
		description,
	})
	breakdown.push(`${txIdx.value++}. ${description}`)
}

export function buildUpgradeTransactions(
	diamondAddress: string,
	protocolAdmin: string,
	migrationRunner: string,
	diamondCut: any[],
	selectorChanges: SelectorChange[],
	chunkSize: number,
	newParams: NewV085Parameters,
): UpgradeTransactionResult {
	const pauseSafeTxs: SafeTransaction[] = []
	const pauseBreakdown: string[] = []
	const pauseTxIdx = { value: 1 }

	// Phase 0: Pause (separate batch — executed as standalone Safe tx before diamondCut)
	pauseSafeTxs.push(toHumanReadableSafeTx(diamondAddress, "grantRole", [protocolAdmin, ethers.id("PAUSER_ROLE")]))
	pauseBreakdown.push(`${pauseTxIdx.value++}. grantRole(PAUSER_ROLE) -> ${protocolAdmin}`)

	pauseSafeTxs.push(toHumanReadableSafeTx(diamondAddress, "grantRole", [protocolAdmin, ethers.id("UNPAUSER_ROLE")]))
	pauseBreakdown.push(`${pauseTxIdx.value++}. grantRole(UNPAUSER_ROLE) -> ${protocolAdmin}`)

	pauseSafeTxs.push(toHumanReadableSafeTx(diamondAddress, "pauseGlobal", []))
	pauseBreakdown.push(`${pauseTxIdx.value++}. pauseGlobal()`)

	// Phase 1: Post-diamondCut transactions
	const safeTxs: SafeTransaction[] = []
	const calldataTxs: CalldataTransaction[] = []
	const breakdown: string[] = []
	const txIdx = { value: 1 }

	// Record insertion index — diamondCut goes here during execution
	const diamondCutInsertionIndex = 0

	// Build diamond cut chunks
	const chunks: any[][] = []
	for (let i = 0; i < diamondCut.length; i += chunkSize) {
		chunks.push(diamondCut.slice(i, i + chunkSize))
	}

	const diamondCutCalldataChunks: DiamondCutCalldata[] = chunks.map((chunk, i) => {
		const selectorCount = chunk.reduce((sum: number, cut: any) => sum + cut.functionSelectors.length, 0)
		const cutTuples = chunk.map((cut: any) => [cut.facetAddress, cut.action, cut.functionSelectors])
		return {
			calldata: diamondIface.encodeFunctionData("diamondCut", [cutTuples, ethers.ZeroAddress, "0x"]),
			description: `diamondCut chunk ${i + 1}/${chunks.length} (${chunk.length} cuts, ${selectorCount} selectors)`,
		}
	})

	// Add diamond cut entries to breakdown (in correct position)
	for (const chunk of diamondCutCalldataChunks) {
		breakdown.push(`${txIdx.value++}. [diamondCut - separate] ${chunk.description}`)
	}

	// Phase 2: Post-upgrade roles and parameters
	addTx(
		safeTxs,
		calldataTxs,
		breakdown,
		txIdx,
		diamondAddress,
		"grantRole",
		[protocolAdmin, ethers.id("PROTOCOL_CONFIG_ROLE")],
		`grantRole(PROTOCOL_CONFIG_ROLE) -> ${protocolAdmin}`,
	)

	addTx(
		safeTxs,
		calldataTxs,
		breakdown,
		txIdx,
		diamondAddress,
		"grantRole",
		[protocolAdmin, ethers.id("COOLDOWN_ADMIN_ROLE")],
		`grantRole(COOLDOWN_ADMIN_ROLE) -> ${protocolAdmin}`,
	)

	const needsFeeAdminRole =
		(newParams.liquidationInsuranceVault && newParams.maxLiquidationProfitPerPosition) ||
		newParams.softLiquidationPenaltyCollector ||
		newParams.minAffiliateFee

	if (needsFeeAdminRole) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"grantRole",
			[protocolAdmin, ethers.id("FEE_ADMIN_ROLE")],
			`grantRole(FEE_ADMIN_ROLE) -> ${protocolAdmin}`,
		)
	}

	// Parameters (conditional)
	if (newParams.maxPartyAConnectionLimit && newParams.maxPartyAConnectionLimit > 0) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setMaxPartyAConnectionLimit",
			[newParams.maxPartyAConnectionLimit],
			`setMaxPartyAConnectionLimit(${newParams.maxPartyAConnectionLimit})`,
		)
	}

	if (newParams.signatureVerifierAddress && ethers.isAddress(newParams.signatureVerifierAddress)) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setSignatureVerifierAddress",
			[newParams.signatureVerifierAddress],
			`setSignatureVerifierAddress(${newParams.signatureVerifierAddress})`,
		)

		// Seed MuonSignatureVerifier with public keys and gateway signers
		const verifierIface = new ethers.Interface([
			"function addPublicKey(tuple(uint256 x, uint8 parity) pubKey)",
			"function addGatewaySigner(address signer)",
			"function setPublicKeyPermissions(tuple(uint256 x, uint8 parity) pubKey, uint8[] functions, bool allowed)",
			"function setGatewaySignerPermissions(address signer, uint8[] functions, bool allowed)",
		])

		if (newParams.muonPublicKeys && newParams.muonPublicKeys.length > 0) {
			for (const key of newParams.muonPublicKeys) {
				const pubKeyTuple = { x: key.x, parity: key.parity }
				safeTxs.push(toHumanReadableSafeTxFromIface(verifierIface, newParams.signatureVerifierAddress, "addPublicKey", [pubKeyTuple]))
				calldataTxs.push({
					to: newParams.signatureVerifierAddress,
					value: "0",
					calldata: verifierIface.encodeFunctionData("addPublicKey", [pubKeyTuple]),
					description: `addPublicKey(x=${key.x.slice(0, 10)}..., parity=${key.parity}) on MuonSignatureVerifier`,
				})
				breakdown.push(`${txIdx.value++}. [verifier] addPublicKey(x=${key.x.slice(0, 10)}..., parity=${key.parity})`)
			}
		}

		if (newParams.muonGatewaySigners && newParams.muonGatewaySigners.length > 0) {
			for (const gw of newParams.muonGatewaySigners) {
				safeTxs.push(toHumanReadableSafeTxFromIface(verifierIface, newParams.signatureVerifierAddress, "addGatewaySigner", [gw]))
				calldataTxs.push({
					to: newParams.signatureVerifierAddress,
					value: "0",
					calldata: verifierIface.encodeFunctionData("addGatewaySigner", [gw]),
					description: `addGatewaySigner(${gw}) on MuonSignatureVerifier`,
				})
				breakdown.push(`${txIdx.value++}. [verifier] addGatewaySigner(${gw})`)
			}
		}

		if (newParams.muonFunctionPermissions && newParams.muonFunctionPermissions.length > 0) {
			const functionIndices = newParams.muonFunctionPermissions.map(name => {
				const idx = MUON_FUNCTION_NAMES.indexOf(name)
				if (idx === -1) throw new Error(`Unknown MuonFunction: ${name}. Valid values: ${MUON_FUNCTION_NAMES.join(", ")}`)
				return idx
			})
			const permissionNames = newParams.muonFunctionPermissions.join(", ")

			if (newParams.muonPublicKeys && newParams.muonPublicKeys.length > 0) {
				for (const key of newParams.muonPublicKeys) {
					const pubKeyTuple = { x: key.x, parity: key.parity }
					safeTxs.push(
						toHumanReadableSafeTxFromIface(verifierIface, newParams.signatureVerifierAddress, "setPublicKeyPermissions", [
							pubKeyTuple,
							functionIndices,
							true,
						]),
					)
					calldataTxs.push({
						to: newParams.signatureVerifierAddress,
						value: "0",
						calldata: verifierIface.encodeFunctionData("setPublicKeyPermissions", [pubKeyTuple, functionIndices, true]),
						description: `setPublicKeyPermissions(x=${key.x.slice(0, 10)}..., parity=${key.parity}, [${permissionNames}], true) on MuonSignatureVerifier`,
					})
					breakdown.push(
						`${txIdx.value++}. [verifier] setPublicKeyPermissions(x=${key.x.slice(0, 10)}..., parity=${key.parity}, [${permissionNames}], true)`,
					)
				}
			}

			if (newParams.muonGatewaySigners && newParams.muonGatewaySigners.length > 0) {
				for (const gw of newParams.muonGatewaySigners) {
					safeTxs.push(
						toHumanReadableSafeTxFromIface(verifierIface, newParams.signatureVerifierAddress, "setGatewaySignerPermissions", [
							gw,
							functionIndices,
							true,
						]),
					)
					calldataTxs.push({
						to: newParams.signatureVerifierAddress,
						value: "0",
						calldata: verifierIface.encodeFunctionData("setGatewaySignerPermissions", [gw, functionIndices, true]),
						description: `setGatewaySignerPermissions(${gw}, [${permissionNames}], true) on MuonSignatureVerifier`,
					})
					breakdown.push(`${txIdx.value++}. [verifier] setGatewaySignerPermissions(${gw}, [${permissionNames}], true)`)
				}
			}
		}
	}

	if (newParams.liquidationInsuranceVault && newParams.maxLiquidationProfitPerPosition) {
		if (!ethers.isAddress(newParams.liquidationInsuranceVault)) {
			throw new Error(`Invalid liquidationInsuranceVault address: ${newParams.liquidationInsuranceVault}`)
		}
		const desc = `setLiquidationInsuranceVaultParams(${newParams.liquidationInsuranceVault}, ${newParams.maxLiquidationProfitPerPosition})`
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setLiquidationInsuranceVaultParams",
			[newParams.liquidationInsuranceVault, newParams.maxLiquidationProfitPerPosition],
			desc,
		)
	}

	if (newParams.softLiquidationPenaltyCollector && ethers.isAddress(newParams.softLiquidationPenaltyCollector)) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setSoftLiquidationPenaltyCollector",
			[newParams.softLiquidationPenaltyCollector],
			`setSoftLiquidationPenaltyCollector(${newParams.softLiquidationPenaltyCollector})`,
		)
	}

	if (newParams.minAffiliateFee) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setMinAffiliateFee",
			[newParams.minAffiliateFee],
			`setMinAffiliateFee(${newParams.minAffiliateFee})`,
		)
	}

	if (newParams.unbindCooldown !== undefined && newParams.unbindCooldown > 0) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setUnbindCooldown",
			[newParams.unbindCooldown],
			`setUnbindCooldown(${newParams.unbindCooldown})`,
		)
	}

	if (newParams.minWithdrawCooldown !== undefined && newParams.minWithdrawCooldown > 0) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setMinWithdrawCooldown",
			[newParams.minWithdrawCooldown],
			`setMinWithdrawCooldown(${newParams.minWithdrawCooldown})`,
		)
	}

	if (newParams.maxWithdrawParts !== undefined && newParams.maxWithdrawParts > 0) {
		addTx(
			safeTxs,
			calldataTxs,
			breakdown,
			txIdx,
			diamondAddress,
			"setMaxWithdrawParts",
			[newParams.maxWithdrawParts],
			`setMaxWithdrawParts(${newParams.maxWithdrawParts})`,
		)
	}

	// Phase 3: Migration + symbol management roles
	addTx(
		safeTxs,
		calldataTxs,
		breakdown,
		txIdx,
		diamondAddress,
		"grantRole",
		[migrationRunner, ethers.id("MIGRATION_ROLE")],
		`grantRole(MIGRATION_ROLE) -> ${migrationRunner}`,
	)

	addTx(
		safeTxs,
		calldataTxs,
		breakdown,
		txIdx,
		diamondAddress,
		"grantRole",
		[migrationRunner, ethers.id("SYMBOL_MANAGER_ROLE")],
		`grantRole(SYMBOL_MANAGER_ROLE) -> ${migrationRunner}`,
	)

	return { pauseSafeTxs, pauseBreakdown, safeTxs, calldataTxs, diamondCutCalldataChunks, diamondCutInsertionIndex, breakdown, selectorChanges }
}

// =============================================================================
// Facet loading
// =============================================================================

export function loadDeployedFacets(filePath: string): DeployedFacets {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Deployed facets file not found: ${filePath}\nRun deployFacets.ts first, or set FACETS_FILE to a valid path.`)
	}
	const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DeployedFacets
	log.ok(`Loaded ${Object.keys(data.facets).length} facets from ${filePath}`)
	return data
}
